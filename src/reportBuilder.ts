import {
  FlakinessReport as FK,
} from '@flakiness/flakiness-report';
import {
  CIUtils,
  GitWorktree,
  ReportUtils
} from '@flakiness/sdk';
import type {
  FullConfig,
  FullProject,
  Location,
  Suite, TestCase,
  TestError,
  TestResult,
  TestStep
} from '@playwright/test/reporter';
import fs from 'node:fs';
import path from 'node:path';
import pkg from '../package.json' with { type: 'json' };

type PwAttachment = TestResult['attachments'][number];

type StdIOEntry = {
  data: Buffer | string,
  stream: FK.Stream,
  time: number,
}

type ProcessingContext = {
  projects: FullProject[],
  environments: FK.Environment[],
  worktree: GitWorktree,
  attachments: Map<string, ReportUtils.Attachment>,
  // Cache FK attachments keyed by the PW Attachment object.
  // This is required since Playwright Test reports the same attachment objects in both
  // test attachment list AND in test steps, IF they're attributed to some step.
  // This caching allows us to save on I/O operations.
  attachmentsCache: Map<PwAttachment, Promise<FK.Attachment|undefined>>,
  unaccessibleAttachmentPaths: string[],
  results: Map<TestCase, Set<TestResult>>,
  stdio: Map<TestResult, StdIOEntry[]>,
  testMappings: Map<string, TestCase>,
}

export function computeFKTestId(envName: string, test: FK.Test, parentSuites: FK.Suite[]): string {
  return JSON.stringify([envName, parentSuites.map(suite => suite.title), test.title]);
}

export async function buildReport(options: {
  worktree: GitWorktree,
  commitId: FK.CommitId,
  config: FullConfig,
  rootSuite: Suite,
  startTimestamp: FK.UnixTimestampMS,
  duration: FK.DurationMS,
  flakinessProject?: string,
  title?: string,
  unattributedErrors?: TestError[],
  results?: Map<TestCase, Set<TestResult>>,
  stdio?: Map<TestResult, StdIOEntry[]>,
}) {
  // get all projects
  const projects = options.rootSuite.suites.map(s => s.project()).filter(p => !!p);
  // For each project, get an environment for that project
  const uniqueNames = new Set<string>();
  const environments: FK.Environment[] = projects.map(project => {
    let defaultName = project.name;
    if (!defaultName.trim())
    defaultName = 'anonymous';

    let name = defaultName;
    for (let i = 2; uniqueNames.has(name); ++i)
    name = `${defaultName}-${i}`;
    uniqueNames.add(defaultName);
    return ReportUtils.createEnvironment({ name });
  });

  const configPath = options.config.configFile ? options.worktree.gitPath(options.config.configFile) : undefined;

  const context: ProcessingContext = {
    projects,
    environments,
    worktree: options.worktree,
    attachments: new Map(),
    attachmentsCache: new Map(),
    unaccessibleAttachmentPaths: [],
    results: options.results ?? new Map(),
    stdio: options.stdio ?? new Map(),
    testMappings: new Map(),
  };

  const report = ReportUtils.normalizeReport({
    flakinessProject: options.flakinessProject,
    title: options.title ?? process.env.FLAKINESS_TITLE,
    category: 'playwright',
    commitId: options.commitId,
    relatedCommitIds: [],
    configPath,
    url: CIUtils.runUrl(),
    generatedBy: { name: pkg.name, version: pkg.version },
    testRunner: options.config.version ? { name: '@playwright/test', version: options.config.version } : undefined,
    runtime: ReportUtils.detectRuntime(),
    environments,
    suites: await toFKSuites(context, options.rootSuite, []),
    unattributedErrors: (options.unattributedErrors ?? []).map(e => toFKTestError(context, e)),
    duration: options.duration,
    startTimestamp: options.startTimestamp,
  });

  return {
    report,
    projects: projects.map((project, idx) => [project, environments[idx]] as const),
    unaccessibleAttachmentPaths: context.unaccessibleAttachmentPaths,
    attachments: Array.from(context.attachments.values()),
    testMappings: context.testMappings,
  };
}

function toFKTestError(context: ProcessingContext, pwError: TestError) {
  return {
    location: pwError.location ? createLocation(context, pwError.location) : undefined,
    message: ReportUtils.stripAnsi(pwError.message ?? '').split('\n')[0],
    snippet: pwError.snippet,
    stack: pwError.stack,
    value: pwError.value,
  }
}

async function toFKSuites(context: ProcessingContext, pwSuite: Suite, parentFKSuites: FK.Suite[]): Promise<FK.Suite[]> {
  const location = pwSuite.location;
  // Location should be missing only for root and project suites. Either way, we skip
  // the suite if there's no location.
  if (pwSuite.type === 'root' || pwSuite.type === 'project' || !location)
    return (await Promise.all(pwSuite.suites.map(suite => toFKSuites(context, suite, parentFKSuites)))).flat();

  let type: FK.SuiteType = 'suite';
  if (pwSuite.type === 'file')
    type = 'file';
  else if (pwSuite.type === 'describe' && !pwSuite.title)
    type = 'anonymous suite';

  const suite: FK.Suite = {
    type,
    title: pwSuite.title,
    location: createLocation(context, location),
    suites: [],
    tests: [],
  };
  parentFKSuites = [...parentFKSuites, suite];
  suite.suites = (await Promise.all(pwSuite.suites.map(suite => toFKSuites(context, suite, parentFKSuites)))).flat();
  suite.tests = await Promise.all(pwSuite.tests.map(test => toFKTest(context, test, parentFKSuites)));
  return [suite];
}

async function toFKTest(context: ProcessingContext, pwTest: TestCase, parentFKSuites: FK.Suite[]): Promise<FK.Test> {
  const test: FK.Test = {
    title: pwTest.title,
    // Playwright Test tags must start with '@' so we cut it off.
    tags: pwTest.tags.map(tag => tag.startsWith('@') ? tag.substring(1) : tag),
    location: createLocation(context, pwTest.location),
    // de-duplication of tests will happen later, so here we will have all attempts.
    attempts: await Promise.all(Array.from(context.results.get(pwTest) ?? new Set<TestResult>()).map(result => toFKRunAttempt(context, pwTest, result))),
  };

  const envIdx = context.projects.indexOf(pwTest.parent.project()!);
  const envName = context.environments[envIdx].name;
  const fkTestId = computeFKTestId(envName, test, parentFKSuites);
  context.testMappings.set(fkTestId, pwTest);
  return test;
}

async function toFKRunAttempt(context: ProcessingContext, pwTest: TestCase, result: TestResult): Promise<FK.RunAttempt> {
  const attempt: FK.RunAttempt = {
    timeout: parseDurationMS(pwTest.timeout),
    annotations: pwTest.annotations.map(annotation => ({
      type: annotation.type,
      description: annotation.description,
      location: annotation.location ? createLocation(context, annotation.location) : undefined,
    })),
    // Project and env indexes are equal.
    environmentIdx: context.projects.indexOf(pwTest.parent.project()!),
    expectedStatus: pwTest.expectedStatus,

    parallelIndex: result.parallelIndex,
    status: result.status as FK.TestStatus,
    errors: result.errors && result.errors.length ? result.errors.map(error => toFKTestError(context, error)) : undefined,
    stdio: buildStdio(context, result),
    steps: result.steps ? await Promise.all(result.steps.map(jsonTestStep => toFKTestStep(context, jsonTestStep))) : undefined,

    startTimestamp: +result.startTime as FK.UnixTimestampMS,
    duration: +result.duration as FK.DurationMS,

    attachments: await toFKAttachments(context, result.attachments),
  };

  return attempt;
}

function buildStdio(context: ProcessingContext, result: TestResult): FK.TimedSTDIOEntry[] | undefined {
  const rawEntries = context.stdio.get(result);
  if (!rawEntries?.length)
    return undefined;
  const stdio: FK.TimedSTDIOEntry[] = [];
  let ts = +result.startTime;
  for (const entry of rawEntries) {
    const dts = Math.max(0, entry.time - ts) as FK.DurationMS;
    ts = entry.time;
    if (Buffer.isBuffer(entry.data))
      stdio.push({ buffer: entry.data.toString('base64'), dts, stream: entry.stream });
    else
      stdio.push({ text: entry.data, dts, stream: entry.stream });
  }
  context.stdio.delete(result);
  return stdio;
}

async function toFKAttachments(context: ProcessingContext, pwAttachments: PwAttachment[]): Promise<FK.Attachment[]|undefined> {
  const all = await Promise.all(pwAttachments.map(psAttachment => toFKAttachment(context, psAttachment)));
  const filtered = all.filter(attachment => attachment !== undefined);
  return filtered.length ? filtered : undefined;
}

async function toFKAttachment(context: ProcessingContext, pwAttachment: PwAttachment): Promise<FK.Attachment | undefined> {
  let result = context.attachmentsCache.get(pwAttachment);
  if (!result) {
    result = (async () => {
      // If we cannot access attachment path, then we should skip this attachment, and add it to the "unaccessible" array.
      if (pwAttachment.path && !(await existsAsync(pwAttachment.path))) {
        context.unaccessibleAttachmentPaths.push(pwAttachment.path);
        return;
      }
      let attachment: ReportUtils.Attachment;
      if (pwAttachment.path)
        attachment = await ReportUtils.createFileAttachment(pwAttachment.contentType, pwAttachment.path);
      else if (pwAttachment.body)
        attachment = await ReportUtils.createDataAttachment(pwAttachment.contentType, pwAttachment.body);
      else
        return;
      context.attachments.set(attachment.id, attachment);
      return {
        id: attachment.id,
        name: pwAttachment.name,
        contentType: pwAttachment.contentType,
      };
    })();
    context.attachmentsCache.set(pwAttachment, result);
  }
  return await result;
}

async function toFKTestStep(context: ProcessingContext, pwStep: TestStep): Promise<FK.TestStep> {
  const step: FK.TestStep = {
    // NOTE: jsonStep.duration was -1 in some playwright versions
    duration: parseDurationMS(Math.max(pwStep.duration, 0)),
    title: pwStep.title,
    location: pwStep.location ? createLocation(context, pwStep.location) : undefined,
    attachments: await toFKAttachments(context, pwStep.attachments),
  };

  if (pwStep.error)
    step.error = toFKTestError(context, pwStep.error);
  if (pwStep.steps)
    step.steps = await Promise.all(pwStep.steps.map(childJSONStep => toFKTestStep(context, childJSONStep)));
  return step;
}

function createLocation(
  context: ProcessingContext,
  pwLocation: Location,
): FK.Location {
  return {
    file: context.worktree.gitPath(path.resolve(pwLocation.file)),
    line: pwLocation.line as FK.Number1Based,
    column: pwLocation.column as FK.Number1Based,
  };
}

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
