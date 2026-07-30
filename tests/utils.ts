import { FlakinessReport } from '@flakiness/flakiness-report';
import { readReport, ReportUtils } from '@flakiness/sdk';
import { expect, PlaywrightTestConfig, TestInfo } from '@playwright/test';
import assert from 'node:assert';
import { execFile, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { durationFromWeightInTitle, reportWithExecutedDurations, startFakeDurationsServer } from './fakeDurationsServer.js';

// On MacOS, the /tmp is a symlink to /private/tmp. This results
// in stack traces using `/private/tmp`. This might confuse some
// location parsers, so our location tests might fail.
// To workaround, we explicitly use `/private/tmp` on mac.
export const ARTIFACTS_DIR = process.platform === 'darwin' ? '/private/tmp/flakiness-playwright' : '/tmp/flakiness-playwright';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

type FlakinessReporterOptions = {
  flakinessProject?: string,
  title?: string,
  endpoint?: string,
  token?: string,
  outputFolder?: string,
  open?: 'always' | 'never' | 'on-failure',
  collectBrowserVersions?: boolean,
  disableUpload?: boolean,
  shardBalancing?: { timingsFile: string },
};

const DEFAULT_FILES: Record<string, string> = {
  'package.json': JSON.stringify({
    'name': 'my-package',
    'version': '1.0.0',
  }),
};

async function initializeDirectoryWithTests(
    testInfo: TestInfo,
    files: Record<string, string>,
    options?: FlakinessReporterOptions,
    playwrightConfig?: PlaywrightTestConfig,
  ): Promise<{ targetDir: string, reportDir: string }> {
  const targetDir = path.join(
    ARTIFACTS_DIR,
    slugify(testInfo.titlePath.join('-')),
  );
  // Clean up any previous run and create fresh directory.
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });

  const reportDir = path.join(targetDir, 'flakiness-report');
  const reporterPath = path.join(PROJECT_ROOT, 'src', 'playwright-test.ts');

  const reporterOptions: FlakinessReporterOptions = {
    ...(options ?? {}),
    outputFolder: reportDir,
    disableUpload: true,
    open: 'never',
  };

  const allFiles: Record<string, string> = { ...DEFAULT_FILES, ...files };
  // Generate default playwright config.
  const fullConfig = {
    ...(playwrightConfig ?? {}),
    reporter: [[reporterPath, reporterOptions]],
  };
  allFiles['playwright.config.ts'] = `
    import { defineConfig } from '@playwright/test';
    export default defineConfig(${JSON.stringify(fullConfig, null, 2)});
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

async function runPlaywright(
  targetDir: string,
  extraEnv?: Record<string, string>,
  cliArgs: string[] = [],
) {
  // Run playwright test in the temp directory.
  // Use NODE_PATH so test files in the temp dir can resolve @playwright/test.
  const playwrightCli = path.join(PROJECT_ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
  assert(fs.existsSync(playwrightCli), `missing Playwright CLI at ${playwrightCli}`);
  const env = {
    ...process.env,
    NODE_PATH: path.join(PROJECT_ROOT, 'node_modules'),
    ...(extraEnv ?? {}),
  };
  delete (env as any)['CI'];
  // Playwright forces colors in its workers. Do not pass through NO_COLOR as
  // well: Node warns about the conflicting variables and attributes that
  // warning to whichever test happens to be running when the worker starts.
  delete (env as any)['NO_COLOR'];
  return await new Promise<{ stdout: string, stderr: string, exitCode: number | null }>(resolve => {
    execFile(process.execPath, [playwrightCli, 'test', ...cliArgs], {
      cwd: targetDir,
      env,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    }, (error, stdout, stderr) => {
      // Playwright exits with non-zero for test failures, which is expected
      // for some tests. We still want the report, so we do not throw here and
      // let callers inspect `exitCode` when they care.
      const exitCode = error ? (typeof (error as any).code === 'number' ? (error as any).code : 1) : 0;
      resolve({ stdout, stderr, exitCode });
    });
  });
}

async function runFlakinessPlaywrightTimings(
  targetDir: string,
  extraEnv: Record<string, string> | undefined,
  args: string[],
) {
  const timingsCli = path.join(PROJECT_ROOT, 'lib', 'flakiness-playwright-timings.js');
  assert(fs.existsSync(timingsCli), `missing flakiness-playwright-timings CLI at ${timingsCli}`);
  const env = {
    ...process.env,
    NODE_PATH: path.join(PROJECT_ROOT, 'node_modules'),
    ...(extraEnv ?? {}),
  };
  delete (env as any)['CI'];
  delete (env as any)['NO_COLOR'];
  return await new Promise<{ stdout: string, stderr: string, exitCode: number | null }>(resolve => {
    execFile(process.execPath, [timingsCli, ...args], {
      cwd: targetDir,
      env,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    }, (error, stdout, stderr) => {
      const exitCode = error ? (typeof (error as any).code === 'number' ? (error as any).code : 1) : 0;
      resolve({ stdout, stderr, exitCode });
    });
  });
}

export async function generateFlakinessReport(
    testInfo: TestInfo,
    files: Record<string, string>,
    options?: FlakinessReporterOptions,
    playwrightConfig?: PlaywrightTestConfig,
    extraEnv?: Record<string, string>,
    cliArgs: string[] = [],
  ): Promise<{
    log: {
        stdout: string;
        stderr: string;
    };
    report: FlakinessReport.Report;
    attachments: ReportUtils.FileAttachment[];
    missingAttachments: FlakinessReport.Attachment[];
  }> {
  const { targetDir, reportDir } = await initializeDirectoryWithTests(testInfo, files, options, playwrightConfig);
  const { stdout, stderr } = await runPlaywright(targetDir, extraEnv, cliArgs);
  return {
    ...(await readReport(reportDir)),
    log: { stdout, stderr },
  };
}

export async function runBalancedShards(
    testInfo: TestInfo,
    files: Record<string, string>,
    shards: number,
    options?: FlakinessReporterOptions,
    playwrightConfig?: PlaywrightTestConfig,
    extraEnv?: Record<string, string>,
    cliArgs: string[] = [],
  ): Promise<{
    totalWeight: number,
    report: FlakinessReport.Report,
    stdout: string,
  }[]> {
  assert(Number.isInteger(shards) && shards >= 1, `shards must be a positive integer, got ${shards}`);

  // Unless the caller brings its own timings file, seed one from a full run:
  // execute every test once (no shard or project filter), then rewrite the
  // executed durations to the title-encoded weights so balancing is
  // deterministic. This mirrors a real previous run's report and — unlike the
  // dropped Durations API path — prices dependency (setup/teardown) projects.
  const seededTimingsFile = 'timings.json';
  const shardBalancing = options?.shardBalancing ?? { timingsFile: seededTimingsFile };

  const { targetDir, reportDir } = await initializeDirectoryWithTests(testInfo, files, {
    ...(options ?? {}),
    shardBalancing,
  }, playwrightConfig);

  if (!options?.shardBalancing) {
    const seed = await runPlaywright(targetDir, extraEnv, ['--workers=1']);
    assert.strictEqual(seed.exitCode, 0, seed.stderr || seed.stdout);
    const { report } = await readReport(reportDir);
    fs.writeFileSync(path.join(targetDir, seededTimingsFile), JSON.stringify(reportWithExecutedDurations(report)));
  }

  const result: { totalWeight: number, report: FlakinessReport.Report, stdout: string }[] = [];
  for (let currentShard = 1; currentShard <= shards; ++currentShard) {
    fs.rmSync(reportDir, { recursive: true, force: true });
    const log = await runPlaywright(targetDir, extraEnv, [`--shard=${currentShard}/${shards}`, '--workers=1', ...cliArgs]);
    assert.strictEqual(log.exitCode, 0, log.stderr || log.stdout);

    const { report } = await readReport(reportDir);
    result.push({ report, totalWeight: reportTotalWeight(report), stdout: log.stdout });
  }
  return result;
}

// Runs a single balanced shard and returns the raw process result WITHOUT
// asserting a zero exit code. Use this to test failure paths (e.g. a bad
// timings file) where the shard generation is expected to fail.
export async function runBalancedShardRaw(
    testInfo: TestInfo,
    files: Record<string, string>,
    shard: string,
    options?: FlakinessReporterOptions,
    playwrightConfig?: PlaywrightTestConfig,
    extraEnv?: Record<string, string>,
    cliArgs: string[] = [],
  ): Promise<{ stdout: string, stderr: string, exitCode: number | null }> {
  const { targetDir } = await initializeDirectoryWithTests(testInfo, files, options, playwrightConfig);
  return await runPlaywright(targetDir, extraEnv, [`--shard=${shard}`, '--workers=1', ...cliArgs]);
}

// Runs `flakiness-playwright-timings fetch` against a fixture. By default it
// authenticates against a fake Durations server (so the reporter's --list run
// fetches synthesized durations); pass `auth: false` to omit credentials and
// exercise the failure path. Returns the process result plus the parsed
// timings report (undefined if none was written).
export async function fetchTimings(
    testInfo: TestInfo,
    files: Record<string, string>,
    playwrightConfig?: PlaywrightTestConfig,
    opts?: { auth?: boolean, cliArgs?: string[] },
  ): Promise<{ exitCode: number | null, stdout: string, stderr: string, timings?: FlakinessReport.Report }> {
  const durationsServer = await startFakeDurationsServer();
  try {
    const { targetDir } = await initializeDirectoryWithTests(testInfo, files, {}, playwrightConfig);
    const timingsFile = path.join(targetDir, 'timings.json');
    const args = ['fetch', '-o', timingsFile, ...(opts?.cliArgs ?? [])];
    const extraEnv = opts?.auth !== false
      ? { FLAKINESS_ACCESS_TOKEN: 'fake-token', FLAKINESS_ENDPOINT: durationsServer.endpoint }
      : undefined;

    const result = await runFlakinessPlaywrightTimings(targetDir, extraEnv, args);
    const timings = fs.existsSync(timingsFile)
      ? JSON.parse(fs.readFileSync(timingsFile, 'utf-8')) as FlakinessReport.Report
      : undefined;
    return { ...result, timings };
  } finally {
    durationsServer[Symbol.dispose]();
  }
}

function reportTotalWeight(report: FlakinessReport.Report): number {
  let totalWeight = 0;
  ReportUtils.visitTests(report, test => {
    for (const attempt of test.attempts) {
      const envName = report.environments[attempt.environmentIdx ?? 0]?.name;
      if (envName === undefined)
        continue;
      totalWeight += durationFromWeightInTitle(test.title, envName) ?? 0;
    }
  });
  return totalWeight;
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

export function reportTestCount(report: FlakinessReport.Report): number {
  let count = 0;
  ReportUtils.visitTests(report, test => count += test.attempts.length);
  return count;
}

export function reportTestTitles(report: FlakinessReport.Report): string[] {
  const titles: string[] = [];
  ReportUtils.visitTests(report, test => {
    for (const _attempt of test.attempts)
      titles.push(test.title);
  });
  return titles;
}
