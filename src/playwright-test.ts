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
  FullProject,
  FullResult,
  Reporter,
  Suite, TestCase, TestError, TestResult
} from '@playwright/test/reporter';
import fs from 'node:fs';
import path from 'node:path';
import * as nodeUtil from 'node:util';
import { buildReport, computeFKTestId } from './reportBuilder.js';
import { generateBalancedShard, parseShardSlot, SHARD_HINT_ENV } from './sharding.js';

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
    // unref() so a pending sample never keeps the host process alive.
    this._telemetryTimer = setTimeout(this._sampleSystem, 1000).unref();
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

    const shardRequest = this._options._mode === 'list' ? parseShardEnv() : undefined;
    if (shardRequest) {
      const durationsReport = shardRequest.timingsFile ? await readTimingsReport(shardRequest.timingsFile) : await fetchTestDurations(report, {
        flakinessAccessToken: this._options.token ?? process.env.FLAKINESS_ACCESS_TOKEN,
        flakinessEndpoint: this._options.endpoint,
      });
      const durationPredictions = computeDurationPredictions(durationsReport, projectToEnvNames, testMappings);
      const shardFile = await generateBalancedShard(shardRequest, this._config, this._rootSuite, durationPredictions);
      await fs.promises.writeFile(shardRequest.testListFile, shardFile);
      // Workaround https://github.com/nodejs/node/issues/56645
      if (process.platform === 'win32')
        await new Promise(x => setTimeout(x, 100));
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
  }
}

function envBool(name: string): boolean {
  return ['1', 'true'].includes(process.env[name]?.toLowerCase() ?? '');
}

type ShardRequest = {
  current: number,
  total: number,
  testListFile: string,
  timingsFile?: string,
};

function parseShardEnv(): ShardRequest | undefined {
  const slot = parseShardSlot(process.env.FLAKINESS_SHARD);
  const fileValue = process.env.FLAKINESS_SHARD_FILE;
  if (!slot || !fileValue)
    return undefined;
  return {
    current: slot.current,
    total: slot.total,
    testListFile: fileValue,
    timingsFile: process.env.FLAKINESS_TIMINGS_FILE,
  };
}

// Default report title when this run is part of a shard. Prefers Playwright's
// native `config.shard` (plain `--shard=N/M` runs) and falls back to the
// `FLAKINESS_SHARD_HINT` env var set by `flakiness-playwright-shard`. Returns
// undefined when the run is not sharded.
function defaultShardTitle(config: FullConfig): string | undefined {
  const slot = config.shard ?? parseShardSlot(process.env[SHARD_HINT_ENV]);
  return slot ? `Shard ${slot.current}/${slot.total}` : undefined;
}

async function readTimingsReport(aPath: string): Promise<FK.Report> {
  let text: string;
  try {
    text = await fs.promises.readFile(aPath, 'utf-8');
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`[flakiness.io] cannot read --timings file "${aPath}": ${reason}`);
  }
  try {
    return JSON.parse(text) as FK.Report;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`[flakiness.io] cannot parse --timings file "${aPath}" as JSON: ${reason}`);
  }
}

function computeDurationPredictions(durationsReport: FK.Report, projectToEnvNames: Map<FullProject, string>, testMappings: Map<string, TestCase[]>) {
  const durationPredictions = new Map<TestCase, number>();
  ReportUtils.visitTests(durationsReport, (test, parentSuites) => {
    // Accumulate test durations per environment: we consider test duration to be a cumulative
    // of all attempts per environment. For example, if it reliably passes only on the second try, then
    // its duration is the sum of the both attempts.
    const durationsPerEnv = new Map<string, number>();
    for (const attempt of test.attempts) {
      const envName = durationsReport.environments[attempt.environmentIdx ?? 0]?.name;
      // Defensive programming: this should never happen.
      if (!envName)
        continue;
      const acc = durationsPerEnv.get(envName) ?? 0;
      durationsPerEnv.set(envName, acc + (attempt.duration ?? 0));
    }
    // No data for the test? Skip it and rely on DEFAULT_DURATION.
    if (!durationsPerEnv.size)
      return;
    const maxDuration = Math.max(...Array.from(durationsPerEnv.values()));

    const fkTestId = computeFKTestId(test, parentSuites);
    const testCases = testMappings.get(fkTestId) ?? [];
    for (const testCase of testCases) {
      // For each test case, find an envName it is mapped to.
      const project = testCase.parent.project();
      const envName = project ? projectToEnvNames.get(project) : undefined;
      // For each test case, we want to find the best timing approximation.
      // We either try to find the environment with the same name (these should be unique),
      // and otherwise use a max duration.
      const envDuration = envName ? durationsPerEnv.get(envName) : undefined;
      // We fallback to the max of the test durations across environments.
      durationPredictions.set(testCase, envDuration ?? maxDuration);
    }
  });
  return durationPredictions;
}