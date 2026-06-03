// Balanced, duration-aware sharding. See docs/sharding.md for the heuristic and
// the cost model that motivate this implementation.
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

  type Shard = {
    groups: ShardGroup[],
    totalDuration: number,
    projects: Set<string>,
  };
  const shards: Shard[] = Array.from({ length: shard.total }, () => ({
    groups: [],
    totalDuration: 0,
    projects: new Set<string>(),
  }));

  // Cost of running a set of dependency projects on a shard. Dependency
  // (setup/teardown) projects are re-run on every shard that needs them, so we
  // only charge for the ones not already present.
  const dependencyCost = (target: Shard, deps: Map<string, number>) => {
    let cost = 0;
    for (const [project, duration] of deps) {
      if (!target.projects.has(project))
        cost += duration;
    }
    return cost;
  };

  const placeGroup = (target: Shard, group: ShardGroup) => {
    target.totalDuration += group.duration + dependencyCost(target, group.deps);
    for (const project of group.deps.keys())
      target.projects.add(project);
    target.groups.push(group);
  };

  // Group shardable entries into clusters that share the exact same set of
  // dependency projects. Tests in one cluster pay for their setup together, so
  // we want to balance them as a unit and avoid duplicating that setup more
  // than necessary.
  type Cluster = {
    groups: ShardGroup[],
    deps: Map<string, number>,
    work: number,
    setupCost: number,
    spread: number,
  };
  const clusters = new Map<string, Cluster>();
  for (const group of groups) {
    const signature = Array.from(group.deps.keys()).sort().join('\0');
    let cluster = clusters.get(signature);
    if (!cluster) {
      cluster = { groups: [], deps: group.deps, work: 0, setupCost: 0, spread: 0 };
      clusters.set(signature, cluster);
    }
    cluster.groups.push(group);
    cluster.work += group.duration;
  }

  // Decide how many shards each cluster should be spread across.
  for (const cluster of clusters.values()) {
    cluster.setupCost = Array.from(cluster.deps.values()).reduce((sum, d) => sum + d, 0);
    const maxShards = Math.min(shard.total, cluster.groups.length);
    // Dependency-free clusters can spread freely. For clusters that carry a
    // setup, only duplicate that setup onto another shard while each shard
    // still carries at least as much real test work as the setup it pays for:
    // splitting `work` across `k` shards is worthwhile only while `work / k`
    // stays above `setupCost`. This keeps a single heavy "setup" project (and
    // .serial suites, which are atomic groups) on as few shards as possible,
    // while still parallelizing genuinely heavy test suites.
    cluster.spread = cluster.setupCost === 0
      ? maxShards
      : Math.min(maxShards, Math.max(1, Math.floor(cluster.work / cluster.setupCost)));
  }

  // Place dependency-bearing clusters first, heaviest first, so they can claim
  // the shards they need; then fill the remaining capacity with dependency-free
  // tests. Within a tier, heavier clusters (counting one setup copy per shard
  // they will occupy) go first.
  const plan = Array.from(clusters.values()).sort((a, b) => {
    if ((a.setupCost > 0) !== (b.setupCost > 0))
      return a.setupCost > 0 ? -1 : 1;
    return (b.work + b.spread * b.setupCost) - (a.work + a.spread * a.setupCost);
  });

  for (const cluster of plan) {
    // Reserve the cheapest `spread` shards to host this cluster, preferring
    // shards that already run the shared dependencies (so we do not pay for
    // them twice) and otherwise the least loaded ones.
    const homeShards = shards
      .map((target, index) => ({ target, index, cost: target.totalDuration + dependencyCost(target, cluster.deps) }))
      .sort((a, b) => a.cost - b.cost || a.index - b.index)
      .slice(0, cluster.spread)
      .map(entry => entry.target);

    // Distribute the cluster's groups across its home shards, largest first,
    // always picking the shard that ends up least loaded (LPT).
    const ordered = [...cluster.groups].sort((a, b) => b.duration - a.duration);
    for (const group of ordered) {
      let best = homeShards[0];
      let bestDuration = best.totalDuration + group.duration + dependencyCost(best, group.deps);
      for (let i = 1; i < homeShards.length; ++i) {
        const candidate = homeShards[i];
        const duration = candidate.totalDuration + group.duration + dependencyCost(candidate, group.deps);
        if (duration < bestDuration) {
          best = candidate;
          bestDuration = duration;
        }
      }
      placeGroup(best, group);
    }
  }

  const selectedShard = shards[shard.current - 1];
  const testIds = selectedShard.groups.map(group => group.ids).flat();
  await fs.promises.writeFile(shard.outputFile, testIds.join('\n') + '\n');
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
