import { test, expect } from '@playwright/test';
import { assertCount, generateFlakinessReport } from './utils';

test('should capture test annotations', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'file-1.spec.ts': `
      import { test } from '@playwright/test';

      test('test-1', async ({}, testInfo) => {
        testInfo.annotations.push({ type: 'issues', description: 'https://github.com/flakiness/playwright/pull/1' });
      });
    `,
  });
  const [file1] = assertCount(report.suites, 1);
  const [test1] = assertCount(file1.tests, 1);
  const [attempt1] = assertCount(test1.attempts, 1);
  expect(attempt1.annotations).toEqual([{
    type: 'issues',
    description: 'https://github.com/flakiness/playwright/pull/1',
  }]);
});
