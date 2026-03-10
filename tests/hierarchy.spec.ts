import { ReportUtils } from '@flakiness/sdk';
import { test, expect } from '@playwright/test';
import { assertCount, generateFlakinessReport } from './utils';

test('should properly report hierarchy', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'file-1.spec.ts': `
      import { test } from '@playwright/test';

      test.describe('suite-1', () => {
        test.describe('suite-2', () => {
          test.describe('suite-3', () => {
            test('test-1', () => {});
            test('test-2', () => {});
          });
          test.describe('suite-4', () => {
            test('test-3', () => {});
          });
        });
      });
    `,

    'file-2.spec.ts': `
      import { test } from '@playwright/test';

      test.describe('suite-6', () => {
        test('test-4', async () => { });
      });
    `,
  });
  const [file1, file2] = assertCount(report.suites, 2);
  expect(file1.title).toBe('file-1.spec.ts');
  expect(file2.title).toBe('file-2.spec.ts');

  const titles: string[] = [];
  ReportUtils.visitTests(report, (test, parents) => {
    titles.push([...parents.map(p => p.title), test.title].join(' > '));
  });
  expect(titles).toEqual([
    'file-1.spec.ts > suite-1 > suite-2 > suite-3 > test-1',
    'file-1.spec.ts > suite-1 > suite-2 > suite-3 > test-2',
    'file-1.spec.ts > suite-1 > suite-2 > suite-4 > test-3',
    'file-2.spec.ts > suite-6 > test-4'
  ]);
});
