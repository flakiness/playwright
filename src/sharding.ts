import type {
  FullConfig,
  Suite, TestCase
} from '@playwright/test/reporter';

type ShardSlot = { current: number, total: number };

type ShardGroup = {
  tests: TestCase[],
  work: number,
  deps: Map<string, number>,
}

// Default to 1 second 'predicted duration' for tests without duration hints.
export const DEFAULT_DURATION = 1000;

export type BalancedShard = {
  tests: TestCase[],
  // Predicted work for this shard: the summed duration predictions of its tests
  // plus the setup cost of every dependency project the shard has to run. This
  // is a serial sum, not wall time - the shard runs it across `config.workers`.
  work: number,
};

export function allocateBalancedShards(config: FullConfig, rootSuite: Suite, durationPredictions: Map<TestCase, number>, shardsCount: number): BalancedShard[] {
  const shardGroups = prepareShardableTestEntries(config, rootSuite, durationPredictions);
  const shards = balanceShards(shardGroups, shardsCount);
  return shards.map(shard => ({
    tests: shard.groups.map(group => group.tests).flat(),
    work: shard.total,
  }));
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
  score: number, // Scratch value used when comparing shard candidates.
  deps: Set<string>,
};

function missingSetup(shard: Shard, family: Family): number {
  return Array.from(family.deps).reduce((acc, [name, weight]) => acc + (shard.deps.has(name) ? 0 : weight), 0);
}

function unseenSetup(shards: Shard[], family: Family): number {
  return Array.from(family.deps).reduce((acc, [name, weight]) => {
    return acc + (shards.some(shard => shard.deps.has(name)) ? 0 : weight);
  }, 0);
}

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
 * - makespan >= family.work / K + family.setup
 *   Makespan is AT LEAST the chunk of work + a family setup. We might have a shard that
 *   has only this chunk of a family
 * - makespan >= (total + minMissingSetup(K) - unseenSetup) / N
 *   Makespan is AT LEAST the absolute perfect balancing of the job. `minMissingSetup(K)`
 *   is the setup missing from the K cheapest host shards, while `unseenSetup` is the
 *   family setup that has not run anywhere and is therefore already counted once in `total`.
 *   `total` is a running shard total + remaining work, where remaining work assumes that
 *   every dependency that hasn't been executed will be executed once, and all the work will
 *   be distributed perfectly.
 *   
 * Once we know K, select its hosts greedily. After each host is selected, its
 * missing setup becomes part of every remaining candidate's estimate.
 * 
 * Finally, we can use basic LPT to balance project work across selected shards.
 */
function balanceShards(entries: ShardGroup[], N: number): Shard[] {
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
      for (const shard of selectedShards)
        shard.score = shard.total + missingSetup(shard, heaviest) + group.work;
      const bestShard = selectedShards.sort((a, b) => a.score - b.score)[0];
      bestShard.groups.push(group);
      bestShard.total = bestShard.score;
      for (const name of group.deps.keys())
        bestShard.deps.add(name);
    }
  }
  return shards;
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
  const missingSetups = shards.map(shard => missingSetup(shard, heaviest)).sort((a, b) => a - b);
  const unseen = unseenSetup(shards, heaviest);

  let minMakeSpan = Infinity;
  let minK = -1;
  // `total` already reserves one copy of every globally unseen dependency.
  // Add the setup missing from the K cheapest hosts, then subtract the
  // reserved copy once to avoid double-counting it.
  let minMissingSetup = 0;
  for (let k = 1; k <= Math.min(N, heaviest.groups.length); ++k) {
    minMissingSetup += missingSetups[k - 1];
    const localMakespan = heaviest.setup + heaviest.work / k;
    const avgMakespan = (total + minMissingSetup - unseen) / N;
    const atLeast = Math.max(avgMakespan, localMakespan);
    if (atLeast <= minMakeSpan) {
      minMakeSpan = atLeast;
      minK = k;
    }
  }
  return minK;
}

function selectShards(shards: Shard[], families: Family[], family: Family, N: number, K: number): Shard[] {
  const total = estimateTotalWork(shards, [...families, family]);
  const unseen = unseenSetup(shards, family);
  const candidates = shards.map(shard => ({
    shard,
    missing: missingSetup(shard, family),
    score: 0,
  }));
  const selected: Shard[] = [];
  let selectedMissingSetup = 0;

  while (selected.length < K) {
    const remainingHostCount = K - selected.length;
    candidates.sort((a, b) => a.missing - b.missing);
    const optimisticHosts = candidates.slice(0, remainingHostCount);
    const optimisticHostSet = new Set(optimisticHosts);
    const optimisticSetup = optimisticHosts.reduce((acc, candidate) => acc + candidate.missing, 0);
    const optimisticSetupWithoutMostExpensive = optimisticSetup - optimisticHosts.at(-1)!.missing;

    for (const candidate of candidates) {
      const localMakespan = candidate.shard.total + candidate.missing + family.work / K;
      const remainingMissingSetup = optimisticHostSet.has(candidate) ? optimisticSetup : optimisticSetupWithoutMostExpensive + candidate.missing;
      const avgMakespan = (total + selectedMissingSetup + remainingMissingSetup - unseen) / N;
      candidate.score = Math.max(localMakespan, avgMakespan);
    }
    candidates.sort((a, b) => a.score - b.score);
    const best = candidates.shift()!;
    selected.push(best.shard);
    selectedMissingSetup += best.missing;
  }
  return selected;
}

function setDifference<T>(set: Set<T>, other: Set<T>): Set<T> {
  const result = new Set<T>();
  for (const value of set) {
    if (!other.has(value))
      result.add(value);
  }
  return result;
}

function prepareShardableTestEntries(config: FullConfig, rootSuite: Suite, durationPredictions: Map<TestCase, number>) {
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

  const projectDurations = new Map<string, number>();
  for (const testCase of rootSuite.allTests()) {
    const project = testCase.parent.project();
    if (!project)
      continue;
    projectDurations.set(project.name, (projectDurations.get(project.name) ?? 0) + (durationPredictions.get(testCase) ?? DEFAULT_DURATION));
  }

  // Group all tests into shard groups. Each shard group is identified either by
  // a suite (an outermost serial suite), or a testCaseId (if tests are executed with repeat-each).
  type ShardGroupId = Suite|TestCase;
  const shardGroups = new Map<ShardGroupId, ShardGroup>();

  for (const testCase of leafTests) {
    const proj = testCase.parent.project();
    if (!proj)
      continue;

    const shardGroupId = computeShardSuite(testCase) ?? testCase;
    let shardGroup = shardGroups.get(shardGroupId);
    if (!shardGroup) {
      shardGroup = {
        deps: new Map(),
        work: 0,
        tests: [],
      }
      shardGroups.set(shardGroupId, shardGroup);
    }
    shardGroup.tests.push(testCase);
    shardGroup.work += durationPredictions.get(testCase) ?? DEFAULT_DURATION;
    for (const dep of leafProjectClosure.get(proj.name) ?? [])
      shardGroup.deps.set(dep, projectDurations.get(dep) ?? 0);
  }
  return Array.from(shardGroups.values());
}

// Playwright does not expose suite mode in reporter types, but native sharding
// uses this runtime field to detect proper sharding mode.
type SuiteWithParallelMode = Suite & { _parallelMode?: string };

function computeShardSuite(testCase: TestCase): Suite|undefined {
  let outermostSequential: Suite | undefined;
  let insideParallel = false;
  let fileSuite: Suite | undefined;
  for (let suite: Suite | undefined = testCase.parent; suite; suite = suite.parent) {
    if (suite.type === 'file')
      fileSuite = suite;
    const parallelMode = (suite as SuiteWithParallelMode)._parallelMode;
    if (parallelMode === 'serial' || parallelMode === 'default')
      outermostSequential = suite; 
    else if (parallelMode === 'parallel')
      insideParallel = true;
  }
  if (!insideParallel)
    return fileSuite;
  if (outermostSequential)
    return outermostSequential;
  return undefined;
}
