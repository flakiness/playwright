import { test, expect } from '@playwright/test';
import { assertCount, assertStatus, generateFlakinessReport } from './utils';

test('should report passed and failed tests', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'sum.spec.ts': `
      import { test, expect } from '@playwright/test';

      test('should work', async () => {
        expect(1 + 1).toBe(2);
      });

      test('should fail', async () => {
        expect(1 + 1).toBe(3);
      });
    `
  });
  expect(report.category).toBe('playwright');
  const [suite] = assertCount(report.suites, 1);
  expect(suite.title).toBe('sum.spec.ts');

  const [passed, failed] = assertCount(suite.tests, 2);
  expect(passed.title).toBe('should work');
  expect(failed.title).toBe('should fail');

  {
    const [attempt] = assertCount(passed.attempts, 1);
    expect(attempt.status ?? 'passed').toBe('passed');
    expect(attempt.expectedStatus ?? 'passed').toBe('passed');
    expect(attempt.duration ?? 0).toBeGreaterThan(0);
    expect(attempt.startTimestamp ?? 0).toBeGreaterThan(0);
  }

  {
    const [attempt] = assertCount(failed.attempts, 1);
    expect(attempt.status ?? 'passed').toBe('failed');
    expect(attempt.expectedStatus ?? 'passed').toBe('passed');
    expect(attempt.duration ?? 0).toBeGreaterThan(0);
    expect(attempt.startTimestamp ?? 0).toBeGreaterThan(0);
  }
});

test('should support test.skip', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'file.spec.ts': `
      import { test, expect } from '@playwright/test';

      test.skip('skipped', async () => {
        expect(1 + 1).toBe(2);
      });
    `
  });
  expect(report.category).toBe('playwright');
  const [suite] = assertCount(report.suites, 1);
  const [skipped] = assertCount(suite.tests, 1);

  expect(skipped.title).toBe('skipped');
  const [attempt] = assertCount(skipped.attempts, 1);
  assertStatus(attempt.status, 'skipped');
  assertStatus(attempt.expectedStatus, 'skipped');
  expect(attempt.startTimestamp ?? 0).toBeGreaterThan(0);
});

test('should support test.fail', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'file.spec.ts': `
      import { test, expect } from '@playwright/test';

      test('should fail', async () => {
        test.fail();
        expect(1 + 1).toBe(3);
      });
    `
  });
  expect(report.category).toBe('playwright');
  const [suite] = assertCount(report.suites, 1);
  const [fails] = assertCount(suite.tests, 1);

  expect(fails.title).toBe('should fail');
  const [attempt] = assertCount(fails.attempts, 1);
  assertStatus(attempt.status, 'failed');
  assertStatus(attempt.expectedStatus, 'failed');
  expect(attempt.startTimestamp ?? 0).toBeGreaterThan(0);
});

test('should support test.fixme', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'file.spec.ts': `
      import { test, expect } from '@playwright/test';

      test('fixme this test', async () => {
        test.fixme();
        expect(1 + 1).toBe(3);
      });
    `
  });
  expect(report.category).toBe('playwright');
  const [suite] = assertCount(report.suites, 1);
  const [fixme] = assertCount(suite.tests, 1);

  expect(fixme.title).toBe('fixme this test');
  const [attempt] = assertCount(fixme.attempts, 1);
  assertStatus(attempt.status, 'skipped');
  assertStatus(attempt.expectedStatus, 'skipped');
});
