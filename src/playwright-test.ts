import {
  FlakinessReport as FK
} from '@flakiness/flakiness-report';
import {
  CPUUtilization,
  fetchTestDurations,
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
import { buildReport } from './reportBuilder.js';
import { allocateBalancedShards } from './sharding.js';
import { computeDurationPredictions, distillTimings } from './timings.js';
import { readReportFile } from './utils.js';

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

// Balanced sharding reads test duration hints from a timings file and packs
// tests into shards by expected runtime when the run is sharded with
// Playwright's `--shard=N/M`. The file is a distilled timings report (see
// `flakiness-playwright-timings`) or any previous run's report.json.
// Requires Playwright 1.62+ (the `Reporter.preprocessSuite()` API).
type ShardBalancing = { timingsFile: string };

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
  private _preprocessSuiteCalled = false;

  constructor(private _options: {
    flakinessProject?: string,
    title?: string,
    endpoint?: string,
    token?: string,
    outputFolder?: string,
    open?: OpenMode,
    collectBrowserVersions?: boolean,
    disableUpload?: boolean,
    shardBalancing?: ShardBalancing,
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
    // unref() so a pending sample never keeps the host process alive.
    this._telemetryTimer = setTimeout(this._sampleSystem, 1000).unref();
  }

  printsToStdio(): boolean {
    return false;
  }

  // Balanced sharding. Playwright calls this hook (1.62+) before `onBegin`
  // with the full un-sharded corpus; we exclude every test that does not
  // belong to shard `config.shard.current` and disable Playwright's native
  // sharding by returning `implementsSharding: true`.
  //
  // NOTE: unlike report generation, errors here are deliberately fatal.
  // Every shard must balance against identical duration hints; if one shard
  // silently fell back to Playwright's native sharding, the shards would
  // disagree on the partition and some tests would run twice while others
  // never run. Playwright surfaces the thrown error and fails the run before
  // any test executes.
  async preprocessSuite(config: FullConfig, suite: Suite): Promise<{ implementsSharding?: boolean } | void> {
    this._preprocessSuiteCalled = true;
    const balancing = this._options.shardBalancing;
    if (!balancing || !config.shard)
      return;
    try {
      const worktreeResult = GitWorktree.initialize(config.rootDir);
      if (!worktreeResult.ok)
        throw new Error(`failed to fetch commit info - is this a git repo? (${worktreeResult.error})`);
      const { commitId, worktree } = worktreeResult;

      // Build a report describing the current corpus: it provides the test
      // mappings that tie historic durations back to live TestCase objects.
      const { testMappings, projectToEnvNames } = await buildReport({
        commitId,
        worktree,
        config,
        rootSuite: suite,
        duration: 0 as FK.DurationMS,
        startTimestamp: Date.now() as FK.UnixTimestampMS,
        flakinessProject: this._options.flakinessProject,
        title: this._options.title ?? process.env.FLAKINESS_TITLE ?? defaultShardTitle(config),
      });

      const durationsReport = await readReportFile(balancing.timingsFile, 'shardBalancing.timingsFile');
      const durationPredictions = computeDurationPredictions(durationsReport, projectToEnvNames, testMappings);
      const balancedShards = allocateBalancedShards(config, suite, durationPredictions, config.shard.total);
      // Keep the current shard; splice it out so `balancedShards` holds only the
      // other shards, and exclude every test that belongs to them.
      balancedShards.splice(config.shard.current - 1, 1);
      const testsToExclude = new Set(balancedShards.flat());
      for (const test of testsToExclude)
        test.exclude();
      return { implementsSharding: true };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`[flakiness.io] failed to generate balanced shard: ${reason}`);
    }
  }

  onBegin(config: FullConfig, suite: Suite) {
    this._config = config;
    this._rootSuite = suite;
    // With `shardBalancing` configured, a sharded run on an older Playwright
    // never calls `preprocessSuite`, so Playwright's native (unbalanced)
    // sharding has silently kicked in. Warn: this is consistent across shards
    // (safe), just not balanced.
    if (this._options.shardBalancing && config.shard && !this._preprocessSuiteCalled)
      warn(`shardBalancing requires Playwright 1.62+ (Reporter.preprocessSuite API); using Playwright's native sharding instead`);
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

    const {
      projects,
      report,
      attachments,
      unaccessibleAttachmentPaths,
      testMappings,
      projectToEnvNames,
    } = await buildReport({
      commitId,
      worktree,
      config: this._config,
      rootSuite: this._rootSuite,
      duration: parseDurationMS(result.duration),
      startTimestamp: +result.startTime as FK.UnixTimestampMS,
      flakinessProject: this._options.flakinessProject,
      results: this._results,
      stdio: this._stdioEntries,
      title: this._options.title ?? process.env.FLAKINESS_TITLE ?? defaultShardTitle(this._config),
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

    // `flakiness-playwright-timings fetch` runs us via `--list` with this env var
    // set: fetch historical durations for the listed tests, distill them into a
    // lean timings report, and write it to the given path.
    const timingsOutput = this._options._mode === 'list' ? process.env.FLAKINESS_TIMINGS_OUTPUT : undefined;
    if (timingsOutput) {
      const durationsReport = await fetchTestDurations(report, {
        flakinessAccessToken: this._options.token ?? process.env.FLAKINESS_ACCESS_TOKEN,
        flakinessEndpoint: this._options.endpoint,
      });
      const timings = distillTimings([durationsReport]);
      await fs.promises.writeFile(timingsOutput, JSON.stringify(timings, null, 2));
      await workaroundNodeWindowsCrash();
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
    await workaroundNodeWindowsCrash();
  }
}

// Workaround https://github.com/nodejs/node/issues/56645.
// On Windows, exiting right after async I/O — the reort upload, or the report written
// in `onEnd` — can tear it down before the bytes are flushed, leaving the
// reader (our test harness, or a `flakiness-playwright-*` wrapper) with a
// truncated file. Yield briefly so libuv drains first.
async function workaroundNodeWindowsCrash() {
  if (process.platform === 'win32')
    await new Promise(x => setTimeout(x, 100));
}

function envBool(name: string): boolean {
  return ['1', 'true'].includes(process.env[name]?.toLowerCase() ?? '');
}

// Default report title when this run is part of a shard (`--shard=N/M`).
// Returns undefined when the run is not sharded.
function defaultShardTitle(config: FullConfig): string | undefined {
  const slot = config.shard;
  return slot ? `Shard ${slot.current}/${slot.total}` : undefined;
}

