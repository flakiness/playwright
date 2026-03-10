import { FlakinessReport } from '@flakiness/flakiness-report';
import { readReport } from '@flakiness/sdk';
import { expect, PlaywrightTestConfig, TestInfo } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// On MacOS, the /tmp is a symlink to /private/tmp. This results
// in stack traces using `/private/tmp`. This might confuse some
// location parsers, so our location tests might fail.
// To workaround, we explicitly use `/private/tmp` on mac.
export const ARTIFACTS_DIR = process.platform === 'darwin' ? '/private/tmp/flakiness-playwright' : '/tmp/flakiness-playwright';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

type FlakinessReporterOptions = {
  flakinessProject?: string,
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

export async function generateFlakinessReport(testInfo: TestInfo, files: Record<string, string>, options?: FlakinessReporterOptions, playwrightConfig?: PlaywrightTestConfig) {
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

  // Run playwright test in the temp directory.
  // Use NODE_PATH so test files in the temp dir can resolve @playwright/test.
  const playwrightBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'playwright');
  const env = {
    ...process.env,
    NODE_PATH: path.join(PROJECT_ROOT, 'node_modules')
  };
  delete (env as any)['CI'];
  let stdout = '';
  let stderr = '';
  try {
    const result = execSync(`"${playwrightBin}" test`, {
      cwd: targetDir,
      stdio: 'pipe',
      env,
    });
    stdout = result.toString();
  } catch (e: any) {
    // Playwright exits with non-zero for test failures, which is expected
    // for some tests. We still want the report.
    stdout = e.stdout?.toString() ?? '';
    stderr = e.stderr?.toString() ?? '';
  }

  return {
    ...(await readReport(reportDir)),
    log: { stdout, stderr },
  };
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
