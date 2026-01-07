import {
  CIUtils,
  FlakinessReport as FK,
  GitWorktree,
  ReportUtils,
  showReport,
  CPUUtilization,
  RAMUtilization,
  uploadReport,
  writeReport
} from '@flakiness/sdk';
import type { BrowserType } from '@playwright/test';
import type {
  FullConfig,
  FullProject,
  FullResult,
  Location,
  Reporter,
  Suite, TestCase, TestError, TestResult,
  TestStep
} from '@playwright/test/reporter';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

const warn = (txt: string) => console.warn(chalk.yellow(`[flakiness.io] ${txt}`));
const err = (txt: string) => console.error(chalk.red(`[flakiness.io] ${txt}`));
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
  unaccessibleAttachmentPaths: string[],
}

type OpenMode = 'always' | 'never' | 'on-failure';

export default class FlakinessReporter implements Reporter {
  private _config?: FullConfig;
  private _rootSuite?: Suite;
  private _results = new Map<TestCase, Set<TestResult>>();
  private _unattributedErrors: TestError[] = [];

  private _cpuUtilization = new CPUUtilization({ precision: 10 });
  private _ramUtilization = new RAMUtilization({ precision: 10 });
  private _report?: FK.Report;
  private _attachments: ReportUtils.Attachment[] = [];
  private _outputFolder: string;

  private _result?: FullResult;

  private _telemetryTimer?: NodeJS.Timeout;

  constructor(private _options: {
    endpoint?: string,
    token?: string,
    outputFolder?: string,
    open?: OpenMode,
    collectBrowserVersions?: boolean,
  } = {}) {
    this._outputFolder = path.join(process.cwd(), this._options.outputFolder ?? process.env.FLAKINESS_OUTPUT_DIR ?? 'flakiness-report');

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

  onTestEnd(test: TestCase, result: TestResult) {
    const results = this._results.get(test) ?? new Set<TestResult>();
    results.add(result);
    this._results.set(test, results);
  }

  private async _toFKSuites(context: ProcessingContext, pwSuite: Suite): Promise<FK.Suite[]> {
    const location = pwSuite.location;
    // Location should be missing only for root and project suites. Either way, we skip
    // the suite if there's no location.
    if (pwSuite.type === 'root' || pwSuite.type === 'project' || !location)
      return (await Promise.all(pwSuite.suites.map(suite => this._toFKSuites(context, suite)))).flat();

    let type: FK.SuiteType = 'suite';
    if (pwSuite.type === 'file')
      type = 'file';
    else if (pwSuite.type === 'describe' && !pwSuite.title)
      type = 'anonymous suite';
  
    return [{
      type,
      title: pwSuite.title,
      location: this._createLocation(context, location),
      suites: (await Promise.all(pwSuite.suites.map(suite => this._toFKSuites(context, suite)))).flat(),
      tests: await Promise.all(pwSuite.tests.map(test => this._toFKTest(context, test))),
    } as FK.Suite];
  }

  private async _toFKTest(context: ProcessingContext, pwTest: TestCase): Promise<FK.Test> {
    return {
      title: pwTest.title,
      // Playwright Test tags must start with '@' so we cut it off.
      tags: pwTest.tags.map(tag => tag.startsWith('@') ? tag.substring(1) : tag),
      location: this._createLocation(context, pwTest.location),
      // de-duplication of tests will happen later, so here we will have all attempts.
      attempts: await Promise.all(Array.from(this._results.get(pwTest) ?? new Set<TestResult>()).map(result => this._toFKRunAttempt(context, pwTest, result))),
    } as FK.Test;
  }

  private async _toFKRunAttempt(context: ProcessingContext, pwTest: TestCase, result: TestResult): Promise<FK.RunAttempt> {
    const attachments: FK.Attachment[] = [];
    const attempt: FK.RunAttempt = {
      timeout: parseDurationMS(pwTest.timeout),
      annotations: pwTest.annotations.map(annotation => ({
        type: annotation.type,
        description: annotation.description,
        location: annotation.location ? this._createLocation(context, annotation.location) : undefined,
      })),
      environmentIdx: context.project2environmentIdx.get(pwTest.parent.project()!)!,
      expectedStatus: pwTest.expectedStatus,

      parallelIndex: result.parallelIndex,
      status: result.status as FK.TestStatus,
      errors: result.errors && result.errors.length ? result.errors.map(error => this._toFKTestError(context, error)) : undefined,
  
      stdout: result.stdout ? result.stdout.map(toSTDIOEntry) : undefined,
      stderr: result.stderr ? result.stderr.map(toSTDIOEntry) : undefined,
  
      steps: result.steps ? result.steps.map(jsonTestStep => this._toFKTestStep(context, jsonTestStep)) : undefined,
  
      startTimestamp: +result.startTime as FK.UnixTimestampMS,
      duration: +result.duration as FK.DurationMS,
  
      attachments,
    };

    await Promise.all((result.attachments ?? []).map(async jsonAttachment => {
      // If we cannot access attachment path, then we should skip this attachment, and add it to the "unaccessible" array.
      if (jsonAttachment.path && !(await existsAsync(jsonAttachment.path))) {
        context.unaccessibleAttachmentPaths.push(jsonAttachment.path);
        return;
      }
      let attachment: ReportUtils.Attachment;
      if (jsonAttachment.path)
        attachment = await ReportUtils.createFileAttachment(jsonAttachment.contentType, jsonAttachment.path);
      else if (jsonAttachment.body)
        attachment = await ReportUtils.createDataAttachment(jsonAttachment.contentType, jsonAttachment.body);
      else
        return;
      context.attachments.set(attachment.id, attachment);
      attachments.push({
        id: attachment.id,
        name: jsonAttachment.name,
        contentType: jsonAttachment.contentType,
      });
    }));

    return attempt;
  }

  private _toFKTestStep(context: ProcessingContext, pwStep: TestStep): FK.TestStep {
    const step: FK.TestStep = {
      // NOTE: jsonStep.duration was -1 in some playwright versions
      duration: parseDurationMS(Math.max(pwStep.duration, 0)),
      title: pwStep.title,
      location: pwStep.location ? this._createLocation(context, pwStep.location) : undefined,
    };

    if (pwStep.location) {
      const resolvedPath = path.resolve(pwStep.location.file);
    }

    if (pwStep.error)
      step.error = this._toFKTestError(context, pwStep.error);
    if (pwStep.steps)
      step.steps = pwStep.steps.map(childJSONStep => this._toFKTestStep(context, childJSONStep));
    return step;
  }

  private _createLocation(
    context: ProcessingContext,
    pwLocation: Location,
  ): FK.Location {
    return {
      file: context.worktree.gitPath(path.resolve(pwLocation.file)),
      line: pwLocation.line as FK.Number1Based,
      column: pwLocation.column as FK.Number1Based,
    };
  }

  private _toFKTestError(context: ProcessingContext, pwError: TestError) {
    return {
      location: pwError.location ? this._createLocation(context, pwError.location) : undefined,
      message: ReportUtils.stripAnsi(pwError.message ?? '').split('\n')[0],
      snippet: pwError.snippet,
      stack: pwError.stack,
      value: pwError.value,
    }
  }

  async onEnd(result: FullResult) {
    clearTimeout(this._telemetryTimer);
    this._cpuUtilization.sample();
    this._ramUtilization.sample();
    if (!this._config || !this._rootSuite)
      throw new Error('ERROR: failed to resolve config');
    let commitId: FK.CommitId;
    let worktree: GitWorktree;
    try {
      worktree = GitWorktree.create(this._config.rootDir);
    } catch (e) {
      warn(`Failed to fetch commit info - is this a git repo?`);
      err(`Report is NOT generated.`);
      return;
    }

    const configPath = this._config.configFile ? worktree.gitPath(this._config.configFile) : undefined;

    const context: ProcessingContext = {
      project2environmentIdx: new Map(),
      worktree,
      attachments: new Map(),
      unaccessibleAttachmentPaths: [],
    };

    const environmentsMap = createEnvironments(this._config.projects);
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

        for (const [project, env] of environmentsMap) {
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
          env.userSuppliedData ??= {};
          env.userSuppliedData['browser'] = (channel ?? browserName).toLowerCase().trim() + ' ' + version;
        }
      } catch (e) {
        err(`Failed to resolve browser version: ${e}`);
      }
    }
    const environments = [...environmentsMap.values()];
    for (let envIdx = 0; envIdx < environments.length; ++envIdx)
      context.project2environmentIdx.set(this._config.projects[envIdx], envIdx);

    const report = ReportUtils.normalizeReport({
      version: 1,
      category: 'playwright',
      commitId: worktree.headCommitId(),
      relatedCommitIds: [],
      configPath,
      url: CIUtils.runUrl(),
      environments,
      suites: await this._toFKSuites(context, this._rootSuite),
      unattributedErrors: this._unattributedErrors.map(e => this._toFKTestError(context, e)),
      duration: parseDurationMS(result.duration),
      startTimestamp: +result.startTime as FK.UnixTimestampMS,
    });
    ReportUtils.collectSources(worktree, report);
    this._cpuUtilization.enrich(report);
    this._ramUtilization.enrich(report);

    for (const unaccessibleAttachment of context.unaccessibleAttachmentPaths)
      warn(`cannot access attachment ${unaccessibleAttachment}`);

    this._report = report;
    this._attachments = await writeReport(report, Array.from(context.attachments.values()), this._outputFolder);
    this._result = result;
  }

  async onExit(): Promise<void> {
    if (!this._report)
      return;

    await uploadReport(this._report, this._attachments, {
      flakinessAccessToken: this._options.token,
      flakinessEndpoint: this._options.endpoint,
    });

    const openMode = this._options.open ?? 'on-failure';
    // Playwright v1.57+ correctly sets up `process.stdin.isTTY`
    // when the reporter is launched via a VSCode Playwright extension.
    // https://github.com/microsoft/playwright/issues/37867
    const shouldOpen = process.stdin.isTTY && !process.env.CI && (openMode === 'always' || (openMode === 'on-failure' && this._result?.status === 'failed'));
    if (shouldOpen) {
      await showReport(this._outputFolder);
    } else {
      const defaultOutputFolder = path.join(process.cwd(), 'flakiness-report');
      const folder = defaultOutputFolder === this._outputFolder ? '' : path.relative(process.cwd(), this._outputFolder);
      console.log(`
To open last Flakiness report, run:

  ${chalk.cyan(`npx flakiness show ${folder}`)}
      `);
    }
  }
}

function toSTDIOEntry(data: Buffer | string): FK.STDIOEntry {
  if (Buffer.isBuffer(data))
    return { buffer: data.toString('base64') };
  return { text: data };
}


type GenericProject = {
  name: string,
  metadata: { [key: string]: any },
}

function createEnvironments<T extends GenericProject>(projects: T[]): Map<T, FK.Environment> {
  // Each environment must have a unique name in this report so that we differentiate between them.
  let uniqueNames = new Set<string>();
  const result = new Map<T, FK.Environment>();
  for (const project of projects) {
    let defaultName = project.name;
    if (!defaultName.trim())
      defaultName = 'anonymous';

    let name = defaultName;
    for (let i = 2; uniqueNames.has(name); ++i)
      name = `${defaultName}-${i}`;
    uniqueNames.add(defaultName);

    const metadata = structuredClone(project.metadata);
    delete metadata.gitDiff;

    result.set(project, ReportUtils.createEnvironment({
      name,
      metadata,
    }));
  }
  return result;
}
