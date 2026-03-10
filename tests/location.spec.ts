import { test, expect } from '@playwright/test';
import { assertCount, generateFlakinessReport } from './utils';

test('should report locations', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'foo/file-1.spec.ts': `
      import { test } from '@playwright/test';

      test.describe('suite-1', () => {
        test('test-1', () => {});
      });
    `,
  });
  const [file] = assertCount(report.suites, 1);
  const [suite1] = assertCount(file.suites, 1);
  const [test1] = assertCount(suite1.tests, 1);

  expect(file.location).toEqual({
    file: 'foo/file-1.spec.ts',
    line: 0,
    column: 0,
  });
  expect(suite1.location).toEqual({
    file: 'foo/file-1.spec.ts',
    line: 4,
    column: 12,
  });
  expect(test1.location).toEqual({
    file: 'foo/file-1.spec.ts',
    line: 5,
    column: 13,
  });
});
