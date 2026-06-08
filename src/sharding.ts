import type {
  FullConfig,
  Suite, TestCase
} from '@playwright/test/reporter';
import fs from 'node:fs';
import path from 'node:path';

type ShardRequest = { current: number, total: number, outputFile: string };

type ShardGroup = {
  ids: string[],
  work: number,
  deps: Map<string, number>,
}

export function parseShardEnv(): ShardRequest | undefined {
  const slotValue = process.env.FLAKINESS_SHARD;
  const fileValue = process.env.FLAKINESS_SHARD_FILE;
  if (!slotValue || !fileValue)
    return undefined;
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(slotValue);
  if (!match)
    return undefined;
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (!total || current < 1 || current > total)
    return undefined;
  return { current, total, outputFile: fileValue };
}

export async function generatePerfectShard(request: ShardRequest, config: FullConfig, rootSuite: Suite, testCaseDurations: Map<TestCase, number>) {
  const shardGropus = prepareShardableTestEntries(config, rootSuite, testCaseDurations);
  const shards = balanceShards(shardGropus, request.total);
  const selectedShard = shards[request.current - 1];
  const testIds = selectedShard.map(shard => shard.ids).flat();
  await fs.promises.writeFile(request.outputFile, testIds.join('\n') + '\n');
}

type Family = {
  groups: ShardGroup[],
  work: number, // Summary of all group's work in the family
  deps: Map<string, number>,
  setup: number,
};

type Shard = {
  groups: ShardGroup[],
  total: number,
  score: number, // used later to store shard score when picking distribution.
  deps: Set<string>,
};

/**
 * Definitions:
 * 1. The task is to split work across N shards.
 * 2. `makespan` is a wall time to execute all work, across all shards.
 * 3. `ShardGroup` is an indivisible unit of work. In Playwright Test, these are generally single
 *    tests or series of serial tests.
 * 4. `Family` is a set of shard groups with the same dependency closure. In Playwright Test world,
 *    different projects might have the same set of dependencies - both "setup" and "teardown".
 *    They'll end up in the same "family".
 * 5. Each family has a `setup` and `work`: the `setup` is a combined price for all dependencies, and `work`
 *    is a combined price of all shard groups.
 * 
 * Main ideas:
 * 1. This is a heuristic algorithm: the strategy is to allocate families
 *    with the heaviest setup first, so that "lighter" family will pad the remainders.
 * 2. Each family is allocated in 3 steps:
 *    (a) figuring the # of shards to distribute the family onto
 *    (b) picking optimal shards
 *    (c) use LPT to balance the family's work across selected shards
 * 
 * To figure the `K` - the # of shards a family should span, we find a K such
 * that the makespan lower bound is as low as possible, for the current shard allocation.

 * The makespan lower bound is defined like this:
 * - makespan >= family.work / K + family.setup + (minimal shard load)
 *   Makespan is AT LEAST the chunk of work + a family setup. We might have a shard that
 *   has only this chunk of a family
 * - makespan >= (total + (K-1) * family.setup) / N
 *   Makespan is AT LEAST the absolute perfect balancing of job (only happens when all
 *   other dependencies are counted once, this family setup is counted once per spanned
 *   shard, and work is rationally divisible).
 *   `total` is a running shard total + remaining work, where remaining work assumes that
 *   every dependency that hasn't been executed will be executed once, and all the work will
 *   be distributed perfectly.
 *   
 * Now, once we know a minimal K, we can estimate makespan for each shard:
 * - makespan >= shard.load + missing_setup + family.work / K
 *   The makespan is no less than the current shard load + all the extra it'll take
 * - makespan >= (all_shard_loads + missing_setup + all_remaining_work) / N
 *   This is the best average we could hope for.
 * 
 * Finally, we can use basic LPT to balance project work across selected shards.
 */
function balanceShards(entries: ShardGroup[], N: number): ShardGroup[][] {
  // 1. All shard groups with the same dependencies are unified into a single "family".
  // In practice, each family is a node in the dependency tree.
  const familiesMap = new Map<string, Family>();
  for (const entry of entries) {
    const familyId = JSON.stringify(Array.from(entry.deps.keys()).sort((a, b) => a < b ? -1 : 1));
    let family = familiesMap.get(familyId);
    if (!family) {
      family = {
        groups: [],
        work: 0,
        setup: Array.from(entry.deps).reduce((acc, [name, weight]) => acc + weight, 0),
        deps: entry.deps,
      };
      familiesMap.set(familyId, family);
    }
    family.groups.push(entry);
    family.work += entry.work;
  }
  const families = Array.from(familiesMap.values()).sort((f1, f2) => f1.setup - f2.setup);

  const shards: Shard[] = Array(N).fill(0).map(() => ({
    groups: [],
    total: 0,
    score: 0,
    deps: new Set(),
  }));
  // 2. While we have more families to distribute, continue the loop!
  while (families.length > 0) {
    // Pick a heaviest family. We'll work with it.
    const heaviest = families.pop()!;
    const K = computeSpan(shards, families, heaviest, N);
    const selectedShards = selectShards(shards, families, heaviest, N, K);

    // Run LPT across the selected shards.
    for (const group of heaviest.groups.toSorted((g1, g2) => g2.work - g1.work)) {
      for (const shard of selectedShards) {
        const missingSetup = Array.from(heaviest.deps).reduce((acc, [name, weight]) => acc + (shard.deps.has(name) ? 0 : weight), 0);
        shard.score = shard.total + missingSetup + group.work;
      }
      const bestShard = selectedShards.sort((s1, s2) => s1.score - s2.score)[0];
      bestShard.groups.push(group);
      bestShard.total = bestShard.score;
      for (const name of group.deps.keys())
        bestShard.deps.add(name);
    }
  }
  return shards.map(shard => shard.groups);
}

/**
 * For a current shard allocation, and a bunch of families to-be-executed,
 * returns an estimate for the remaining work.
 * @param shards 
 * @param families 
 * @returns 
 */
function estimateTotalWork(shards: Shard[], families: Family[]): number {
  const executedDeps = new Set(shards.map(shard => Array.from(shard.deps)).flat());
  const remainingDeps = new Map(families.map(f => Array.from(f.deps)).flat().filter(([name, weight]) => !executedDeps.has(name)));
  const remainingSetup = Array.from(remainingDeps).reduce((acc, [name, weight]) => acc + weight, 0);
  const remainingWork = families.reduce((acc, f) => acc + f.work, 0);
  const shardsTotal = shards.reduce((acc, shard) => acc + shard.total, 0);
  return shardsTotal + remainingSetup + remainingWork;
}

function computeSpan(shards: Shard[], families: Family[], heaviest: Family, N: number) {
  const total = estimateTotalWork(shards, [...families, heaviest]);

  let minMakeSpan = Infinity;
  let minK = -1;
  for (let k = 1; k <= Math.min(N, heaviest.groups.length); ++k) {
    const localMakespan = heaviest.setup + heaviest.work / k;
    const avgMakespan = (total + (k - 1) * heaviest.setup) / N;
    const atLeast = Math.max(avgMakespan, localMakespan);
    if (atLeast <= minMakeSpan) {
      minMakeSpan = atLeast;
      minK = k;
    }
  }
  return minK;
}

function selectShards(shards: Shard[], families: Family[], heaviest: Family, N: number, K: number): Shard[] {
  const totalWithoutHeaviest = estimateTotalWork(shards, families);

  for (const shard of shards) {
    const missingSetup = Array.from(heaviest.deps).reduce((acc, [name, weight]) => acc + (shard.deps.has(name) ? 0 : weight), 0);
    const localMakespan = shard.total + missingSetup + heaviest.work / K;
    const avgMakespan = (totalWithoutHeaviest + missingSetup + (K - 1) * heaviest.setup + heaviest.work) / N;
    shard.score = Math.max(localMakespan, avgMakespan);
  }
  return shards.toSorted((s1, s2) => s1.score - s2.score).slice(0, K);
}

function setDifference<T>(set: Set<T>, other: Set<T>): Set<T> {
  const result = new Set<T>();
  for (const value of set) {
    if (!other.has(value))
      result.add(value);
  }
  return result;
}

function prepareShardableTestEntries(config: FullConfig, rootSuite: Suite, testCaseDurations: Map<TestCase, number>) {
  // We consider both dependencies and teardown as "dependencies".
  const scheduledProjects = new Set(rootSuite.allTests().map(test => test.parent.project()).filter(x => x !== undefined));
  const projectDependencies = new Map<string, string[]>(Array.from(scheduledProjects).map(project => [project.name, [
    project.dependencies,
    project.teardown ? [project.teardown] : [],
  ].flat()]));
  const leafProjects = setDifference(new Set(projectDependencies.keys()), new Set(Array.from(projectDependencies.values()).flat()))
  const leafTests = rootSuite.allTests().filter(test => {
    const project = test.parent.project();
    return project && leafProjects.has(project.name);
  });

  const visit = (project: string, visited: Set<string> = new Set()) => {
    visited.add(project);
    for (const dep of projectDependencies.get(project) ?? [])
      visit(dep, visited);
    return visited;
  }

  const leafProjectClosure = new Map<string, Set<string>>(Array.from(leafProjects, proj => {
    const allDeps = visit(proj);
    allDeps.delete(proj);
    return [proj, allDeps]
  }));

  // Default duration should be either P50 if we have SOME data, or just 1 second otherwise.
  const defaultDuration = testCaseDurations.size > 0 ? Array.from(testCaseDurations.values()).sort((a, b) => a - b)[testCaseDurations.size / 2 | 0] : 1000;

  const projectDurations = new Map<string, number>();
  for (const testCase of rootSuite.allTests()) {
    const project = testCase.parent.project();
    if (!project)
      continue;
    projectDurations.set(project.name, (projectDurations.get(project.name) ?? 0) + (testCaseDurations.get(testCase) ?? defaultDuration));
  }

  // Group all tests into shard groups. Each shard group is identified either by
  // a suite (an outermost serial suite), or a testCaseId (if tests are executed with repeat-each).
  type ShardGroupId = Suite|string;
  const shardGroups = new Map<ShardGroupId, ShardGroup>();

  for (const testCase of leafTests) {
    const proj = testCase.parent.project();
    if (!proj)
      continue;

    const testEntryId = createTestEntryId(testCase, config.rootDir);
    const shardGroupId = outermostSerialSuite(testCase) ?? testEntryId;
    let shardGroup = shardGroups.get(shardGroupId);
    if (!shardGroup) {
      shardGroup = {
        deps: new Map(),
        work: 0,
        ids: [],
      }
      shardGroups.set(shardGroupId, shardGroup);
    }
    shardGroup.ids.push(testEntryId);
    shardGroup.work += testCaseDurations.get(testCase) ?? defaultDuration;
    for (const dep of leafProjectClosure.get(proj.name) ?? [])
      shardGroup.deps.set(dep, projectDurations.get(dep) ?? 0);
  }
  return Array.from(shardGroups.values());
}

// Playwright does not expose suite mode in reporter types, but native sharding
// uses this runtime field to keep serial suites together.
type SuiteWithParallelMode = Suite & { _parallelMode?: string };

function outermostSerialSuite(testCase: TestCase): Suite | undefined {
  let result: Suite | undefined;
  for (let suite: Suite | undefined = testCase.parent; suite; suite = suite.parent) {
    if ((suite as SuiteWithParallelMode)._parallelMode === 'serial')
      result = suite;
  }
  return result;
}


function createTestEntryId(testCase: TestCase, rootDir: string): string {
  // TestCase.titlePath() returns ['', projectName, fileRelative, ...describeTitles, testTitle].
  // Playwright's --test-list parser expects: `[projectName] › relativeFile › title1 › ... › testTitle`,
  // with `›` (U+203A) as the delimiter and the file path relative to config.rootDir (posix).
  const titlePath = testCase.titlePath();
  const projectName = titlePath[1] ?? '';
  const titles = titlePath.slice(3);
  const relativeFile = path.relative(rootDir, testCase.location.file).split(path.sep).join('/');
  const segments = [];
  if (projectName)
    segments.push(`[${projectName}]`);
  segments.push([relativeFile, testCase.location.line, testCase.location.column].join(':'), ...titles);
  return segments.join(' › ');
}
