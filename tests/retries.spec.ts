import { test, expect } from '@playwright/test';
import { assertCount, generateFlakinessReport } from './utils';

test('should handle retries', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'smoke.spec.ts': `
      import { test, expect } from '@playwright/test';
      import fs from 'fs';
      import path from 'path';

      test('retryretry', async () => {
        const counterFile = path.join(process.cwd(), '.attempt-counter');
        let count = 0;
        try { count = parseInt(fs.readFileSync(counterFile, 'utf-8')); } catch {}
        count++;
        fs.writeFileSync(counterFile, String(count));
        expect(count).toBeGreaterThan(2);
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
