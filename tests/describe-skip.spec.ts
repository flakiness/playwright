import { test, expect } from '@playwright/test';
import { assertCount, assertStatus, generateFlakinessReport } from './utils';

test('should handle tests in skipped describe blocks', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'file.spec.ts': `
      import { test } from '@playwright/test';

      test('foo', () => {});
      test.describe('bar', () => {
        test.describe.skip('baz', () => {
          test('test', () => {});
        });
      });
    `
  });
  expect(report.category).toBe('playwright');
  const [file] = assertCount(report.suites, 1);
  const [barSuite] = assertCount(file.suites, 1);
  const [bazSuite] = assertCount(barSuite.suites, 1);
  const [skipped] = assertCount(bazSuite.tests, 1);

  expect(skipped.title).toBe('test');
  const [attempt] = assertCount(skipped.attempts, 1);
  assertStatus(attempt.status, 'skipped');
  assertStatus(attempt.expectedStatus, 'skipped');
  expect(attempt.startTimestamp ?? 0).toBeGreaterThan(0);
});
