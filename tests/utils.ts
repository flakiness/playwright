import { FlakinessReport } from '@flakiness/flakiness-report';
import { readReport, ReportUtils } from '@flakiness/sdk';
import { expect, PlaywrightTestConfig, TestInfo } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { brotliDecompressSync } from 'node:zlib';

// On MacOS, the /tmp is a symlink to /private/tmp. This results
// in stack traces using `/private/tmp`. This might confuse some
// location parsers, so our location tests might fail.
// To workaround, we explicitly use `/private/tmp` on mac.
export const ARTIFACTS_DIR = process.platform === 'darwin' ? '/private/tmp/flakiness-playwright' : '/tmp/flakiness-playwright';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

export type FlakinessReporterOptions = {
  flakinessProject?: string,
  title?: string,
  endpoint?: string,
  token?: string,
  outputFolder?: string,
  open?: 'always' | 'never' | 'on-failure',
  collectBrowserVersions?: boolean,
  disableUpload?: boolean,
};

export type PlaywrightRunLog = {
  stdout: string;
  stderr: string;
};

export type PlaywrightRunResult = {
  exitCode: number;
  log: PlaywrightRunLog;
};

export type TestProject = {
  targetDir: string;
  reportDir: string;
};

type FakeDurationServer = {
  endpoint: string;
  uploadedReports: FlakinessReport.Report[];
  close: () => Promise<void>;
};

export type GeneratePerfectShardsOptions = {
  total: number;
  durations?: Record<string, number>;
  defaultDuration?: number;
  reporterOptions?: FlakinessReporterOptions;
  playwrightConfig?: PlaywrightTestConfig;
  extraEnv?: Record<string, string>;
  cliArgs?: string[];
};

const DEFAULT_FILES: Record<string, string> = {
  'package.json': JSON.stringify({
    'name': 'my-package',
    'version': '1.0.0',
  }),
};

export function createPlaywrightProject(
    testInfo: TestInfo,
    files: Record<string, string>,
    reporterOptions?: FlakinessReporterOptions,
    playwrightConfig?: PlaywrightTestConfig,
): TestProject {
  const targetDir = path.join(
    ARTIFACTS_DIR,
    slugify(testInfo.titlePath.join('-')),
  );
  // Clean up any previous run and create fresh directory.
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });

  const reportDir = path.join(targetDir, 'flakiness-report');
  const reporterPath = path.join(PROJECT_ROOT, 'src', 'playwright-test.ts');

  const fullReporterOptions: FlakinessReporterOptions = {
    ...(reporterOptions ?? {}),
    outputFolder: reportDir,
    disableUpload: true,
    open: 'never',
  };

  const allFiles: Record<string, string> = { ...DEFAULT_FILES, ...files };
  // Generate default playwright config.
  const fullConfig = {
    ...(playwrightConfig ?? {}),
    reporter: [[reporterPath, fullReporterOptions]],
  };
  allFiles['playwright.config.ts'] = `
    import { defineConfig } from '@playwright/test';
    export default defineConfig(${serializeConfigValue(fullConfig)});
  `;

  // Write test files into the tmp folder.
  for (const [filePath, content] of Object.entries(allFiles)) {
    const fullPath = path.join(targetDir, ...filePath.split('/'));
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  // Initialize a git repo and commit all files.
  execSync('git init', { cwd: targetDir, stdio: 'pipe' });
  execSync('git add .', { cwd: targetDir, stdio: 'pipe' });
  execSync('git -c user.email=john@example.com -c user.name=john -c commit.gpgsign=false commit -m staging', {
    cwd: targetDir,
    stdio: 'pipe',
  });

  return { targetDir, reportDir };
}

export async function generateFlakinessReport(
    testInfo: TestInfo,
    files: Record<string, string>,
    options?: FlakinessReporterOptions,
    playwrightConfig?: PlaywrightTestConfig,
    extraEnv?: Record<string, string>,
    cliArgs: string[] = [],
  ): Promise<{
    log: PlaywrightRunLog;
    report: FlakinessReport.Report;
    attachments: ReportUtils.FileAttachment[];
    missingAttachments: FlakinessReport.Attachment[];
  }> {
  const project = createPlaywrightProject(testInfo, files, options, playwrightConfig);
  const { log } = await runPlaywrightTest(project.targetDir, cliArgs, extraEnv);

  return {
    ...(await readReport(project.reportDir)),
    log,
  };
}

export function runPlaywrightTest(
    targetDir: string,
    cliArgs: string[] = [],
    extraEnv?: Record<string, string>,
): Promise<PlaywrightRunResult> {
  const playwrightBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'playwright');
  const env = {
    ...process.env,
    NODE_PATH: path.join(PROJECT_ROOT, 'node_modules'),
    ...(extraEnv ?? {}),
  };
  delete (env as any)['CI'];
  return new Promise(resolve => {
    const child = spawn(playwrightBin, ['test', ...cliArgs], {
      cwd: targetDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', chunk => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.on('error', error => {
      resolve({
        exitCode: 1,
        log: {
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString() + error.message,
        },
      });
    });
    child.on('close', code => {
      // Playwright exits with non-zero for test failures, which is expected
      // for some tests. We still want the report.
      resolve({
        exitCode: code ?? 1,
        log: {
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        },
      });
    });
  });
}

export async function generatePerfectShards(
    testInfo: TestInfo,
    files: Record<string, string>,
    options: GeneratePerfectShardsOptions,
): Promise<TestProject & {
  allEntries: string[];
  shardFiles: string[];
  shards: string[][];
  runs: PlaywrightRunResult[];
}> {
  if (options.total < 1)
    throw new Error(`Expected at least one shard, got ${options.total}`);

  const durationServer = await createFakeDurationServer({
    durations: options.durations,
    defaultDuration: options.defaultDuration,
  });
  try {
    const project = createPlaywrightProject(testInfo, files, {
      ...(options.reporterOptions ?? {}),
      endpoint: durationServer.endpoint,
      token: 'test-token',
    }, options.playwrightConfig);

    const allEntries = await listTestEntries(project.targetDir, options.cliArgs);
    const shardDir = path.join(project.targetDir, 'perfect-shards');
    fs.mkdirSync(shardDir, { recursive: true });

    const shardFiles: string[] = [];
    const runs: PlaywrightRunResult[] = [];
    for (let current = 1; current <= options.total; ++current) {
      const shardFile = path.join(shardDir, `shard-${current}.txt`);
      shardFiles.push(shardFile);
      const result = await runPlaywrightTest(project.targetDir, ['--list', ...(options.cliArgs ?? [])], {
        ...(options.extraEnv ?? {}),
        FLAKINESS_SHARD: `${current}/${options.total}`,
        FLAKINESS_SHARD_FILE: shardFile,
        FLAKINESS_ACCESS_TOKEN: 'test-token',
      });
      runs.push(result);
      if (result.exitCode !== 0)
        throw new Error(`Failed to generate perfect shard ${current}/${options.total}\nstdout:\n${result.log.stdout}\nstderr:\n${result.log.stderr}`);
    }

    return {
      ...project,
      allEntries,
      shardFiles,
      shards: readShardFiles(shardFiles),
      runs,
    };
  } finally {
    await durationServer.close();
  }
}

export async function listTestEntries(targetDir: string, cliArgs: string[] = []): Promise<string[]> {
  const result = await runPlaywrightTest(targetDir, ['--list', '--reporter=list', ...cliArgs]);
  if (result.exitCode !== 0)
    throw new Error(`Failed to list tests\nstdout:\n${result.log.stdout}\nstderr:\n${result.log.stderr}`);
  return result.log.stdout.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && line !== 'Listing tests:' && !line.startsWith('Total:'));
}

export function readShardFiles(shardFiles: string[]): string[][] {
  return shardFiles.map(shardFile => fs.readFileSync(shardFile, 'utf-8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean));
}

export function runShard(targetDir: string, shardFile: string, cliArgs: string[] = [], extraEnv?: Record<string, string>): Promise<PlaywrightRunResult> {
  return runPlaywrightTest(targetDir, ['--test-list', shardFile, ...cliArgs], extraEnv);
}

export function assertShardCoverage(shards: string[][], expectedEntries: string[]) {
  const entries = shards.flat();
  expect(new Set(entries).size).toBe(entries.length);
  expect([...entries].sort()).toEqual([...expectedEntries].sort());
}

async function createFakeDurationServer(options: {
  durations?: Record<string, number>;
  defaultDuration?: number;
} = {}): Promise<FakeDurationServer> {
  const uploadedReports: FlakinessReport.Report[] = [];
  let durationReport: FlakinessReport.Report | undefined;
  let endpoint = '';
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', endpoint);
      if (request.method === 'POST' && url.pathname === '/api/testDurations/create') {
        jsonResponse(response, {
          testDurationsToken: 'test-durations-token',
          uploadUrl: `${endpoint}/upload`,
        });
        return;
      }

      if (request.method === 'PUT' && url.pathname === '/upload') {
        const body = await readRequestBody(request);
        const json = request.headers['content-encoding'] === 'br' ? brotliDecompressSync(body).toString('utf-8') : body.toString('utf-8');
        const report = JSON.parse(json) as FlakinessReport.Report;
        uploadedReports.push(report);
        durationReport = reportWithDurations(report, options);
        response.writeHead(200);
        response.end();
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/testDurations/submit') {
        jsonResponse(response, { downloadUrl: `${endpoint}/download` });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/download') {
        if (!durationReport) {
          response.writeHead(404);
          response.end();
          return;
        }
        jsonResponse(response, durationReport);
        return;
      }

      response.writeHead(404);
      response.end();
    } catch (e) {
      response.writeHead(500);
      response.end(e instanceof Error ? e.message : String(e));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind fake duration server'));
        return;
      }
      endpoint = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });

  return {
    endpoint,
    uploadedReports,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function readRequestBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function jsonResponse(response: http.ServerResponse, value: unknown) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

function reportWithDurations(report: FlakinessReport.Report, options: {
  durations?: Record<string, number>;
  defaultDuration?: number;
}): FlakinessReport.Report {
  const result = JSON.parse(JSON.stringify(report)) as FlakinessReport.Report;
  const visitSuites = (suites: FlakinessReport.Suite[] | undefined, parentSuites: FlakinessReport.Suite[]) => {
    for (const suite of suites ?? []) {
      const nextParents = [...parentSuites, suite];
      for (const test of suite.tests ?? []) {
        const attempts: FlakinessReport.RunAttempt[] = [];
        for (const [environmentIdx, env] of result.environments.entries()) {
          const duration = durationForTest(options, env.name, test, nextParents);
          if (duration === undefined)
            continue;
          attempts.push({
            environmentIdx,
            status: 'passed' as FlakinessReport.TestStatus,
            startTimestamp: 0 as FlakinessReport.UnixTimestampMS,
            duration: duration as FlakinessReport.DurationMS,
          });
        }
        test.attempts = attempts;
      }
      visitSuites(suite.suites, nextParents);
    }
  };
  visitSuites(result.suites, []);
  return result;
}

function durationForTest(
    options: {
      durations?: Record<string, number>;
      defaultDuration?: number;
    },
    envName: string,
    test: FlakinessReport.Test,
    parentSuites: FlakinessReport.Suite[],
): number | undefined {
  const entry = reportTestEntry(envName, test, parentSuites);
  const anonymousEntry = reportTestEntry('', test, parentSuites);
  return options.durations?.[entry] ??
      options.durations?.[anonymousEntry] ??
      durationFromTitle(test.title) ??
      options.defaultDuration;
}

function durationFromTitle(title: string): number | undefined {
  const match = /(?:^|[^\w])d:(missing|\d+)(?=$|[^\w])/.exec(title);
  if (!match || match[1] === 'missing')
    return undefined;
  return Number(match[1]);
}

function reportTestEntry(envName: string, test: FlakinessReport.Test, parentSuites: FlakinessReport.Suite[]): string {
  const location = test.location;
  const titlePath = [
    ...parentSuites.filter(suite => suite.type !== 'file').map(suite => suite.title),
    test.title,
  ];
  const segments: string[] = [];
  if (envName && envName !== 'anonymous')
    segments.push(`[${envName}]`);
  if (location)
    segments.push(`${location.file}:${location.line}:${location.column}`);
  segments.push(...titlePath);
  return segments.join(' › ');
}

function serializeConfigValue(value: unknown): string {
  if (value instanceof RegExp)
    return value.toString();
  if (Array.isArray(value))
    return `[${value.map(item => serializeConfigValue(item)).join(', ')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => `${JSON.stringify(key)}: ${serializeConfigValue(entryValue)}`);
    return `{\n${entries.join(',\n')}\n}`;
  }
  if (typeof value === 'function')
    return value.toString();
  return JSON.stringify(value);
}

function slugify(text: string) {
  return text
    // Replace anything not alphanumeric or dash with dash
    .replace(/[^.a-zA-Z0-9-]+/g, '-')
    // Collapse multiple dashes
    .replace(/-+/g, '-')
    // Trim leading/trailing dash
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

export function assertCount<T>(elements: T[] | undefined, count: number): T[] {
  expect(elements?.length).toBe(count);
  return elements!;
}

export function assertStatus(status: FlakinessReport.TestStatus | undefined, expected: FlakinessReport.TestStatus) {
  expect(status ?? 'passed').toBe(expected);
}

export function assertStdioEntry(entry: FlakinessReport.TimedSTDIOEntry, text: string, expected: FlakinessReport.Stream) {
  expect(entry.stream ?? FlakinessReport.STREAM_STDOUT).toBe(expected);
  expect((entry as any).text).toBe(text);
}
