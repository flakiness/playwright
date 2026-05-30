import {
  FlakinessReport as FK,
} from '@flakiness/flakiness-report';
import {
  CPUUtilization,
  GitWorktree,
  RAMUtilization,
  ReportUtils,
  showReport,
  showReportCommand,
  uploadReport,
  writeReport
} from '@flakiness/sdk';
import { BrowserType } from '@playwright/test';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite, TestCase, TestError, TestResult
} from '@playwright/test/reporter';
import fs from 'node:fs';
import path from 'node:path';
import * as nodeUtil from 'node:util';
import { fetchHistoricalDurations } from './durations.js';
import { buildReport, computeFKTestId } from './reportBuilder.js';

type StyleTextFormat = Parameters<NonNullable<typeof nodeUtil.styleText>>[0];

const styleText = (format: StyleTextFormat, text: string) => nodeUtil.styleText?.(format, text) ?? text;
const warn = (txt: string) => console.warn(styleText('yellow', `[flakiness.io] ${txt}`));
const err = (txt: string) => console.error(styleText('red', `[flakiness.io] ${txt}`));
const log = (txt: string) => console.log(`[flakiness.io] ${txt}`);

function parseDurationMS(value: number) {
  if (isNaN(value))
    throw new Error('Duration cannot be NaN');

  if (value < 0)
    throw new Error(`Duration cannot be less than 0, found ${value}`);
  return (value|0) as FK.DurationMS;
}

type OpenMode = 'always' | 'never' | 'on-failure';

type StdIOEntry = {
  data: Buffer | string,
  stream: FK.Stream,
  time: number,
}

type ReporterMode = 'list' | 'test' | 'merge';

export default class FlakinessReporter implements Reporter {
  private _config?: FullConfig;
  private _rootSuite?: Suite;
  private _results = new Map<TestCase, Set<TestResult>>();
  private _stdioEntries = new Map<TestResult, StdIOEntry[]>();
  private _unattributedErrors: TestError[] = [];

  private _cpuUtilization = new CPUUtilization({ precision: 10 });
  private _ramUtilization = new RAMUtilization({ precision: 10 });
  private _report?: FK.Report;
  private _attachments: ReportUtils.Attachment[] = [];
  private _outputFolder: string;

  private _result?: FullResult;

  private _telemetryTimer?: NodeJS.Timeout;

  constructor(private _options: {
    flakinessProject?: string,
    title?: string,
    endpoint?: string,
    token?: string,
    outputFolder?: string,
    open?: OpenMode,
    collectBrowserVersions?: boolean,
    disableUpload?: boolean,
    // Injected by Playwright when constructing built-in reporters; 'list' for `--list` runs.
    _mode?: ReporterMode,
  } = {}) {
    this._outputFolder = path.resolve(process.cwd(), this._options.outputFolder ?? process.env.FLAKINESS_OUTPUT_DIR ?? 'flakiness-report');

    this._sampleSystem = this._sampleSystem.bind(this);
    this._sampleSystem();
  }

  private _sampleSystem() {
    this._cpuUtilization.sample();
    this._ramUtilization.sample();
    this._telemetryTimer = setTimeout(this._sampleSystem, 1000);
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, suite: Suite) {
    this._config = config;
    this._rootSuite = suite;
  }

  onError(error: TestError): void {
    this._unattributedErrors.push(error);
  }

  onTestBegin(test: TestCase) {
  }

  onStdOut(chunk: string | Buffer, test: TestCase | void, result: TestResult | void) {
    this._onStdio(chunk, 'stdout', result);
  }

  onStdErr(chunk: string | Buffer, test: TestCase | void, result: TestResult | void) {
    this._onStdio(chunk, 'stderr', result);
  }

  private _onStdio(chunk: string | Buffer, stream: 'stdout' | 'stderr', result: TestResult | void) {
    if (!result) return;
    let entries = this._stdioEntries.get(result);
    if (!entries) {
      entries = [];
      this._stdioEntries.set(result, entries);
    }
    entries.push({
      data: chunk,
      stream: stream === 'stderr' ? FK.STREAM_STDERR : FK.STREAM_STDOUT,
      time: Date.now()
    });
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const results = this._results.get(test) ?? new Set<TestResult>();
    results.add(result);
    this._results.set(test, results);
  }

  async onEnd(result: FullResult) {
    clearTimeout(this._telemetryTimer);
    this._cpuUtilization.sample();
    this._ramUtilization.sample();
    if (!this._config || !this._rootSuite)
      throw new Error('ERROR: failed to resolve config');
    const worktreeResult = GitWorktree.initialize(this._config.rootDir);
    if (!worktreeResult.ok) {
      warn(`Failed to fetch commit info - is this a git repo? (${worktreeResult.error})`);
      err(`Report is NOT generated.`);
      return;
    }
    const { commitId, worktree } = worktreeResult;

    const { projects, report, attachments, unaccessibleAttachmentPaths, testMappings } = await buildReport({
      commitId,
      worktree,
      config: this._config,
      rootSuite: this._rootSuite,
      duration: parseDurationMS(result.duration),
      startTimestamp: +result.startTime as FK.UnixTimestampMS,
      flakinessProject: this._options.flakinessProject,
      results: this._results,
      stdio: this._stdioEntries,
      title: this._options.title,
      unattributedErrors: this._unattributedErrors,
    });

    if (this._options.collectBrowserVersions) {
      try {
        // The process.argv[1] is the absolute path of the playwright executable than runs this custom
        // reporter. It also runs tests.
        // Unfortunately, we're not given the Playwright instance in the playwright api;
        // as a result, jump through a few hoops to get the instance.
        // 
        // 1. Resolve process.argv[1] to absolute path. This is a symlink that points to some file
        //    inside the @playwright/test node module.
        // 2. Go up until we reach the "test" directory.
        // 3. Playwright's main import is the 'index.js' file.
        let playwrightPath = fs.realpathSync(process.argv[1]);
        while (path.basename(playwrightPath) !== 'test')
          playwrightPath = path.dirname(playwrightPath);
        const module = await import(path.join(playwrightPath, 'index.js'));

        for (const [project, env] of projects) {
          const { browserName = 'chromium', channel, headless } = project.use;

          let browserType: BrowserType;
          switch (browserName) {
            case 'chromium': browserType = module.default.chromium; break;
            case 'firefox': browserType = module.default.firefox; break;
            case 'webkit': browserType = module.default.webkit; break;
            default: throw new Error(`Unsupported browser: ${browserName}`);
          }

          const browser = await browserType.launch({ channel, headless });
          const version = browser.version();
          await browser.close();
          env.metadata ??= {};
          env.metadata['browser'] = (channel ?? browserName).toLowerCase().trim() + ' ' + version;
        }
      } catch (e) {
        err(`Failed to resolve browser version: ${e}`);
      }
    }

    const shardRequest = parseShardEnv();
    if (this._options._mode === 'list' && shardRequest) {
      // Generate shard and do nothing else.
      await this._generatePerfectShard(shardRequest, report, testMappings);
      return;
    }

    ReportUtils.collectSources(worktree, report);
    this._cpuUtilization.enrich(report);
    this._ramUtilization.enrich(report);

    for (const unaccessibleAttachment of unaccessibleAttachmentPaths)
      warn(`cannot access attachment ${unaccessibleAttachment}`);

    this._report = report;
    this._attachments = await writeReport(report, attachments, this._outputFolder);
    this._result = result;
  }

  private async _generatePerfectShard(shard: ShardRequest, report: FK.Report, testMappings: Map<string, TestCase>) {
    // Fetch durations from the Flakiness.io
    const durationsReport = await fetchHistoricalDurations(report, {
      flakinessAccessToken: this._options.token ?? process.env.FLAKINESS_ACCESS_TOKEN,
      flakinessEndpoint: this._options.endpoint,
    });
    // Map durations to the test case instances.
    const testCaseDurations = new Map<TestCase, number>();
    ReportUtils.visitTests(durationsReport, (test, parentSuites) => {
      for (const attempt of test.attempts) {
        const envName = durationsReport.environments[attempt.environmentIdx ?? 0].name;
        const fkTestId = computeFKTestId(envName, test, parentSuites);
        const testCase = testMappings.get(fkTestId);
        if (testCase && attempt.duration !== undefined)
          testCaseDurations.set(testCase, attempt.duration);
      }
    });

    const { entries, projectDurations } = prepareShardableTestEntries(this._config!, this._rootSuite!, testCaseDurations);
    // stable sort all entries.
    entries.sort((e1, e2) => {
      if (e1.duration !== e2.duration)
        return e2.duration - e1.duration;
      return e1.id < e2.id ? -1 : e1.id > e2.id ? 1 : 0;
    })

    type Shard = {
      entries: TestEntry[],
      totalDuration: number,
      projects: Set<string>,
    };
    const shards: Shard[] = Array(shard.total).fill(0).map(() => ({
      entries: [],
      totalDuration: 0,
      projects: new Set(),
    }));

    const addToShardDuration = (shard: Shard, entry: TestEntry) => {
      const newProjects = setDifference(entry.projectDeps, shard.projects);
      return Array.from(newProjects, proj => projectDurations.get(proj) ?? 0).reduce((acc, ms) => acc + ms, 0) + entry.duration;
    }

    const addShardEntry = (shard: Shard, entry: TestEntry) => {
      shard.entries.push(entry);
      shard.totalDuration += addToShardDuration(shard, entry);
      shard.projects = setUnion(shard.projects, entry.projectDeps);
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

    await fs.promises.writeFile(shard.outputFile, shards[shard.current - 1].entries.map(entry => entry.id).join('\n') + '\n');
  }

  async onExit(): Promise<void> {
    if (!this._report)
      return;

    const disableUpload = this._options.disableUpload ?? envBool('FLAKINESS_DISABLE_UPLOAD');
    if (!disableUpload) {
      await uploadReport(this._report, this._attachments, {
        flakinessAccessToken: this._options.token,
        flakinessEndpoint: this._options.endpoint,
      });
    }

    const openMode = this._options.open ?? 'on-failure';
    // Playwright v1.57+ correctly sets up `process.stdin.isTTY`
    // when the reporter is launched via a VSCode Playwright extension.
    // https://github.com/microsoft/playwright/issues/37867
    const shouldOpen = process.stdin.isTTY && !process.env.CI && (openMode === 'always' || (openMode === 'on-failure' && this._result?.status === 'failed'));
    if (shouldOpen) {
      await showReport(this._outputFolder);
    } else {
      const command = showReportCommand(this._outputFolder);
      console.log(`
To open last Flakiness report, run:

  ${styleText('cyan', command)}
      `);
    }
  }
}

function envBool(name: string): boolean {
  return ['1', 'true'].includes(process.env[name]?.toLowerCase() ?? '');
}

function setDifference<T>(set: Set<T>, other: Set<T>): Set<T> {
  const result = new Set<T>();
  for (const value of set) {
    if (!other.has(value))
      result.add(value);
  }
  return result;
}

function setUnion<T>(set: Set<T>, other: Set<T>): Set<T> {
  const result = new Set<T>(set);
  for (const value of other)
    result.add(value);
  return result;
}

type ShardRequest = { current: number, total: number, outputFile: string };

function parseShardEnv(): ShardRequest | undefined {
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

export function prepareShardableTestEntries(config: FullConfig, rootSuite: Suite, testCaseDurations: Map<TestCase, number>) {
  const projectDependencies = new Map<string, string[]>(config.projects.map(project => [project.name, project.dependencies]));
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
  const defaultDuration = testCaseDurations.size > 0 ? Array.from(testCaseDurations.values()).sort((a, b) => a - b)[testCaseDurations.size / 2|0] : 1000;

  const projectDurations = new Map<string, number>();
  for (const testCase of rootSuite.allTests()) {
    const project = testCase.parent.project();
    if (!project)
      continue;
    projectDurations.set(project.name, (projectDurations.get(project.name) ?? 0) + (testCaseDurations.get(testCase) ?? defaultDuration));
  }

  // Now, leaf tests that share the same TestEntryId should be merged together with combined duration.
  // We cannot shard these.
  const testEntries = new Map<string, TestEntry>();
  for (const testCase of leafTests) {
    const proj = testCase.parent.project();
    if (!proj)
      continue;
    const id = createTestEntryId(testCase, config.rootDir);
    let entry = testEntries.get(id);
    if (!entry) {
      entry = {
        duration: 0,
        id,
        projectDeps: leafProjectClosure.get(proj.name) ?? new Set(),
      };
      testEntries.set(id, entry);
    }
    entry.duration += testCaseDurations.get(testCase) ?? defaultDuration;
  }

  return { entries: Array.from(testEntries.values()), projectDurations };
}

type TestEntry = {
  id: string,
  duration: number,
  projectDeps: Set<string>,
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
