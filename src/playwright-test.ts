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
import { buildReport } from './reportBuilder.js';

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

async function existsAsync(aPath: string) {
  return fs.promises.stat(aPath).then(() => true).catch(e => false);
}

type ProcessingContext = {
  project2environmentIdx: Map<FullProject, number>,
  worktree: GitWorktree,
  attachments: Map<string, ReportUtils.Attachment>,
  // Cache FK attachments keyed by the PW Attachment object.
  // This is required since Playwright Test reports the same attachment objects in both
  // test attachment list AND in test steps, IF they're attributed to some step.
  // This caching allows us to save on I/O operations.
  attachmentsCache: Map<PwAttachment, Promise<FK.Attachment|undefined>>,
  unaccessibleAttachmentPaths: string[],
}


type PwAttachment = TestResult['attachments'][number];

type OpenMode = 'always' | 'never' | 'on-failure';

type StdIOEntry = {
  data: Buffer | string,
  stream: FK.Stream,
  time: number,
}

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

    const { report, attachments, unaccessibleAttachmentPaths } = await buildReport({
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
