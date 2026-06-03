import type {
  FullConfig,
  Suite, TestCase
} from '@playwright/test/reporter';
import fs from 'node:fs';
import path from 'node:path';

type ShardRequest = { current: number, total: number, outputFile: string };

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

export async function generatePerfectShard(shard: ShardRequest, config: FullConfig, rootSuite: Suite, testCaseDurations: Map<TestCase, number>) {
  const groups = prepareShardableTestEntries(config, rootSuite, testCaseDurations);
  const shards = assignGroupsToShards(groups, shard.total);
  const testIds = shards[shard.current - 1].map(group => group.ids).flat();
  await fs.promises.writeFile(shard.outputFile, testIds.join('\n') + '\n');
}

// A family unites all shard groups that share the same dependency closure:
// whichever shard runs any of its groups must also run the `deps` projects
// in full, paying the `setup` price on top of the group durations.
type Family = {
  key: string,
  deps: Map<string, number>,
  setup: number,
  work: number,
  groups: ShardGroup[],
};

type Shard = {
  load: number,
  projects: Set<string>,
  groups: ShardGroup[],
};

// Distributes shard groups over `shardCount` shards, minimizing the slowest shard.
// See docs/sharding.md for the description and worked examples.
//
// Groups are merged into families by dependency closure. Families are placed one
// by one, the most expensive setup first. Each family decides how many shards to
// span — splitting family work k ways re-runs its dependency projects on every
// extra shard, so wider spans must pay for themselves — then picks the shards
// (preferring ones that already run its dependencies) and LPT-distributes its
// groups over them. Zero-setup families are placed last and act as filler that
// evens out the shards; without any dependencies the whole algorithm degenerates
// to classic LPT.
function assignGroupsToShards(groups: ShardGroup[], shardCount: number): ShardGroup[][] {
  const families = new Map<string, Family>();
  for (const group of groups) {
    const key = Array.from(group.deps.keys()).sort().join('\n');
    let family = families.get(key);
    if (!family) {
      family = {
        key,
        deps: group.deps,
        setup: sum(group.deps.values()),
        work: 0,
        groups: [],
      };
      families.set(key, family);
    }
    family.work += group.duration;
    family.groups.push(group);
  }
  const orderedFamilies = Array.from(families.values()).sort((f1, f2) =>
    (f2.setup - f1.setup) || (f2.work - f1.work) || (f1.key < f2.key ? -1 : 1));

  const shards: Shard[] = Array.from({ length: shardCount }, () => ({
    load: 0,
    projects: new Set<string>(),
    groups: [],
  }));

  // The dependency time the shard would have to add to run the given projects.
  const missingSetup = (shard: Shard, deps: Map<string, number>) => {
    let result = 0;
    for (const [project, duration] of deps) {
      if (!shard.projects.has(project))
        result += duration;
    }
    return result;
  };

  let remainingWork = sum(orderedFamilies.map(family => family.work));

  for (const [familyIndex, family] of orderedFamilies.entries()) {
    // Estimate the total work across all shards once everything is placed:
    // current shard loads, all unplaced groups, and every dependency project
    // that is not running anywhere yet, counted once.
    const loadsSum = sum(shards.map(shard => shard.load));
    const pendingDeps = new Map<string, number>();
    for (const futureFamily of orderedFamilies.slice(familyIndex)) {
      for (const [dep, duration] of futureFamily.deps) {
        if (!shards.some(shard => shard.projects.has(dep)))
          pendingDeps.set(dep, duration);
      }
    }
    const estimatedTotal = loadsSum + remainingWork + sum(pendingDeps.values());

    // Decide how many shards the family spans. Both bounds limit the makespan:
    // - the best possible load of a shard hosting 1/k of the family,
    // - the average shard load, inflated by the k - 1 extra setup copies.
    // More shards relieve the first bound but inflate the second one. On a tie
    // prefer the wider span (only possible with a zero setup) for parallelism.
    const maxSpan = Math.min(shardCount, family.groups.length);
    let span = 1;
    let spanCost = Infinity;
    for (let k = 1; k <= maxSpan; ++k) {
      const cost = Math.max(
        family.setup + family.work / k,
        (estimatedTotal + (k - 1) * family.setup) / shardCount);
      if (cost <= spanCost) {
        span = k;
        spanCost = cost;
      }
    }

    // Choose the shards to span: the same two bounds, now per shard. Through
    // `missing`, shards already running some of the family's dependencies are
    // preferred over equally loaded ones. Sorting is stable, so equal scores
    // resolve to the lowest shard index, keeping the assignment deterministic.
    const scoredShards = shards.map(shard => {
      const missing = missingSetup(shard, family.deps);
      return {
        shard,
        score: Math.max(
          shard.load + missing + family.work / span,
          (loadsSum + missing + remainingWork) / shardCount),
      };
    });
    scoredShards.sort((s1, s2) => s1.score - s2.score);
    const candidates = scoredShards.slice(0, span).map(scored => scored.shard);

    // Classic LPT over the chosen shards: largest groups first, each group goes
    // where it ends up the cheapest. A shard pays the family setup only when
    // a group actually lands on it. Group listing order is stable and so is the
    // sort, which keeps equal-duration groups in listing order.
    const orderedGroups = family.groups.slice().sort((g1, g2) => g2.duration - g1.duration);
    for (const group of orderedGroups) {
      let target = candidates[0];
      let targetLoad = Infinity;
      for (const candidate of candidates) {
        const load = candidate.load + missingSetup(candidate, group.deps) + group.duration;
        if (load < targetLoad) {
          target = candidate;
          targetLoad = load;
        }
      }
      target.load = targetLoad;
      target.groups.push(group);
      for (const dep of group.deps.keys())
        target.projects.add(dep);
    }

    remainingWork -= family.work;
  }

  return shards.map(shard => shard.groups);
}

function sum(values: Iterable<number>): number {
  let result = 0;
  for (const value of values)
    result += value;
  return result;
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
        duration: 0,
        ids: [],
      }
      shardGroups.set(shardGroupId, shardGroup);
    }
    shardGroup.ids.push(testEntryId);
    shardGroup.duration += testCaseDurations.get(testCase) ?? defaultDuration;
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

type ShardGroup = {
  ids: string[],
  duration: number,
  deps: Map<string, number>,
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
