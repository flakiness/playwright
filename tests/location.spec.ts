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

  expect(file.location?.file).toBe('foo/file-1.spec.ts');
  expect(suite1.location?.file).toBe('foo/file-1.spec.ts');
  expect(test1.location?.file).toBe('foo/file-1.spec.ts');
  expect(suite1.location?.line).toBeGreaterThan(0);
  expect(test1.location?.line).toBeGreaterThan(0);
});
