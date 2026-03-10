import { test, expect } from '@playwright/test';
import { assertCount, generateFlakinessReport } from './utils';

test('should capture test tags', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'file-1.spec.ts': `
      import { test } from '@playwright/test';

      test('test-1', { tag: '@smoke' }, async () => {});
    `,
  });
  const [file1] = assertCount(report.suites, 1);
  const [test1] = assertCount(file1.tests, 1);
  expect(test1.tags).toEqual(['smoke']);
});
