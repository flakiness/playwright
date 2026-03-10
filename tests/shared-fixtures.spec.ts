import { expect, test } from '@playwright/test';
import { assertCount, generateFlakinessReport } from './utils';

test('should report tests from shared fixtures imported by multiple spec files', async ({}, testInfo) => {
  const { report, log } = await generateFlakinessReport(testInfo, {
    'fixtures.ts': `
      import { test } from '@playwright/test';

      export function defineTests() {
        test('shared test', () => {});
      }
    `,
    'a.spec.ts': `
      import { defineTests } from './fixtures';
      defineTests();
    `,
    'b.spec.ts': `
      import { defineTests } from './fixtures';
      defineTests();
    `,
  });

  const [suiteA, suiteB] = assertCount(report.suites, 2);

  const [testA] = assertCount(suiteA.tests, 1);
  const [testB] = assertCount(suiteB.tests, 1);
  expect(testA.location?.file).toBe('fixtures.ts');
  expect(testB.location?.file).toBe('fixtures.ts');
});
