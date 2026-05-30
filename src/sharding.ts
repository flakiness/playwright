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
  const entries = prepareShardableTestEntries(config, rootSuite, testCaseDurations);
  // Since initially entry listing is stable, and node.js sorting is stable too,
  // we can just rearrange them according to the duration.
  entries.sort((e1, e2) => e2.duration - e1.duration);

  type Shard = {
    groups: ShardGroup[],
    totalDuration: number,
    projects: Set<string>,
  };
  const shards: Shard[] = Array(shard.total).fill(0).map(() => ({
    groups: [],
    totalDuration: 0,
    projects: new Set(),
  }));

  const addToShardDuration = (shard: Shard, entry: ShardGroup) => {
    let addedPrice = entry.duration;
    for (const [proj, projDuration] of entry.deps) {
      if (!shard.projects.has(proj))
        addedPrice += projDuration;
    }
    return addedPrice;
  }

  const addShardEntry = (shard: Shard, entry: ShardGroup) => {
    shard.groups.push(entry);
    shard.totalDuration += addToShardDuration(shard, entry);
    for (const proj of entry.deps.keys())
      shard.projects.add(proj);
  }

  for (const testEntry of entries) {
    let minShardIdx = 0;
    let minShardDuration = shards[0].totalDuration + addToShardDuration(shards[0], testEntry);
    for (let shardIdx = 1; shardIdx < shards.length; ++shardIdx) {
      const d = shards[shardIdx].totalDuration + addToShardDuration(shards[shardIdx], testEntry);
      if (d < minShardDuration) {
        minShardIdx = shardIdx;
        minShardDuration = d;
      }
    }
    addShardEntry(shards[minShardIdx], testEntry);
  }

  const selectedShard = shards[shard.current - 1];
  const testIds = selectedShard.groups.map(shard => shard.ids).flat();
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
