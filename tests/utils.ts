import { FlakinessReport } from '@flakiness/flakiness-report';
import { readReport, ReportUtils } from '@flakiness/sdk';
import { expect, PlaywrightTestConfig, TestInfo } from '@playwright/test';
import assert from 'node:assert';
import { execFile, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { durationFromWeightInTitle, startFakeDurationsServer } from './fakeDurationsServer.js';

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
  return await new Promise<{ stdout: string, stderr: string }>(resolve => {
    execFile(process.execPath, [playwrightCli, 'test', ...cliArgs], {
      cwd: targetDir,
      env,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    }, (_error, stdout, stderr) => {
      // Playwright exits with non-zero for test failures, which is expected
      // for some tests. We still want the report.
      resolve({ stdout, stderr });
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

export async function runPerfectShards(
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
  }[]> {
  assert(Number.isInteger(shards) && shards >= 1, `shards must be a positive integer, got ${shards}`);

  using durationsServer = await startFakeDurationsServer();
  const { targetDir, reportDir } = await initializeDirectoryWithTests(testInfo, files, {
    ...(options ?? {}),
    endpoint: durationsServer.endpoint,
    token: options?.token ?? 'fake-token',
  }, playwrightConfig);

  const result: { totalWeight: number, report: FlakinessReport.Report }[] = [];
  for (let currentShard = 1; currentShard <= shards; ++currentShard) {
    const shardFile = path.join(targetDir, `shard_${currentShard.toString().padStart(3, '0')}.txt`);
    await runPlaywright(targetDir, {
      ...(extraEnv ?? {}),
      FLAKINESS_SHARD: `${currentShard}/${shards}`,
      FLAKINESS_SHARD_FILE: shardFile,
    }, [...cliArgs, '--list']);
    assert(fs.existsSync(shardFile), `failed to generate shard file ${shardFile}`);

    fs.rmSync(reportDir, { recursive: true, force: true });
    await runPlaywright(targetDir, extraEnv, [...cliArgs, `--test-list=${shardFile}`, '--pass-with-no-tests']);

    const { report } = await readReport(reportDir);
    result.push({ report, totalWeight: reportTotalWeight(report) });
  }
  return result;
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
