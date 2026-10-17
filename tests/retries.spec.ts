import { expect, test } from '@playwright/test';
import { assertCount, generateFlakinessReport } from './utils.js';

test('should handle retries', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'smoke.spec.ts': `
      import { test, expect } from '@playwright/test';
      import fs from 'fs';
      import path from 'path';

      test('retryretry', async ({}, testInfo) => {
        expect(testInfo.retry).toBeGreaterThanOrEqual(2);
      });

      test('noretry', async () => { });
    `,
  }, {}, {
    retries: 2,
  });

  const [suite] = assertCount(report.suites, 1);
  const [testWithRetries, testNoRetry] = assertCount(suite.tests, 2);
  expect(testWithRetries.title).toBe('retryretry');
  const [attempt1, attempt2, attempt3] = assertCount(testWithRetries.attempts, 3);
  expect(attempt1.status ?? 'passed').toBe('failed');
  expect(attempt2.status ?? 'passed').toBe('failed');
  expect(attempt3.status ?? 'passed').toBe('passed');

  assertCount(testNoRetry.attempts, 1);
});

test('should drop attempts that did not run', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'smoke.spec.ts': `
      import { test, expect } from '@playwright/test';

      test.describe.serial('serial', () => {
        test('first', async ({}, testInfo) => {
          expect(testInfo.retry).toBeGreaterThan(0);
        });

        test('second', async () => {
          expect(1).toBe(2);
        });

        test('third', async () => {});
      });
    `,
  }, {}, {
    retries: 2,
  });

  const [fileSuite] = assertCount(report.suites, 1);
  const [serialSuite] = assertCount(fileSuite.suites, 1);
  const [first, second, third] = assertCount(serialSuite.tests, 3);
  expect(first.attempts.map(a => a.status ?? 'passed')).toEqual(['failed', 'passed', 'passed']);
  // Playwright: failed. The first attempt did not run, so it is not reported.
  expect(second.attempts.map(a => a.status ?? 'passed')).toEqual(['failed', 'failed']);
  // Playwright: did not run. Same as tests that never started because of --max-failures.
  expect(third.attempts).toEqual([]);
});

test('should keep explicit skips on retry', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'smoke.spec.ts': `
      import { test, expect } from '@playwright/test';

      test('skips on retry', async ({}, testInfo) => {
        test.skip(testInfo.retry > 0, 'skip on retry');
        expect(1).toBe(2);
      });
    `,
  }, {}, {
    retries: 1,
  });

  const [fileSuite] = assertCount(report.suites, 1);
  const [skipsOnRetry] = assertCount(fileSuite.tests, 1);
  expect(skipsOnRetry.attempts.map(a => a.status ?? 'passed')).toEqual(['failed', 'skipped']);
  expect(skipsOnRetry.attempts.map(a => a.expectedStatus ?? 'passed')).toEqual(['skipped', 'skipped']);
});

test('should drop interrupted attempts', async ({}, testInfo) => {
  test.skip(process.platform === 'win32', 'process.kill() cannot deliver SIGINT on Windows');
  const { report } = await generateFlakinessReport(testInfo, {
    'smoke.spec.ts': `
      import { test, expect } from '@playwright/test';

      test('interrupted on retry', async ({}, testInfo) => {
        expect(testInfo.retry).toBeGreaterThan(0);
        // Interrupt the test runner, as if a user pressed Ctrl-C.
        process.kill(process.ppid, 'SIGINT');
        await new Promise(() => {});
      });
    `,
  }, {}, {
    retries: 1,
  });

  const [fileSuite] = assertCount(report.suites, 1);
  const [interruptedOnRetry] = assertCount(fileSuite.tests, 1);
  expect(interruptedOnRetry.attempts.map(a => a.status ?? 'passed')).toEqual(['failed']);
});
