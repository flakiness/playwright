import { expect, test } from '@playwright/test';
import { assertCount, generateFlakinessReport } from './utils';

test('should capture test errors', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'file-1.spec.ts': `
      import { test, expect } from '@playwright/test';

      test('test-1', async () => {
        expect(1).toBe(2);
      });
    `,
  });
  expect(report.unattributedErrors?.length ?? 0).toBe(0);
  const [file] = assertCount(report.suites, 1);
  const [test1] = assertCount(file.tests, 1);
  const [attempt] = assertCount(test1.attempts, 1);
  const [error] = assertCount(attempt.errors, 1);
  expect(error.message).toContain('expected');
  expect(error.location).toEqual({
    line: 5,
    column: 19,
    file: 'file-1.spec.ts',
  });
});

test('should generate report when tests have syntax errors', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'file.spec.ts': `
      import (){{ test, expect from '@playwright/test';
    `,
  });
  expect(report.unattributedErrors?.length).toBeGreaterThanOrEqual(1);
  assertCount(report.environments, 1);
});
