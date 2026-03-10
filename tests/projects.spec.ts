import { test, expect } from '@playwright/test';
import { assertCount, generateFlakinessReport } from './utils';

test('should capture multiple projects', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'file.spec.ts': `
      import { test } from '@playwright/test';

      test('test', async () => { });
    `,
  }, {}, {
    projects: [
      { name: 'node' },
      { name: 'browser' },
    ],
  });
  const [file] = assertCount(report.suites, 1);
  const [t] = assertCount(file.tests, 1);
  const [attempt1, attempt2] = assertCount(t.attempts, 2);
  expect(attempt1.environmentIdx ?? 0).not.toBe(attempt2.environmentIdx ?? 0);
  expect(report.environments.length).toBe(2);
  expect(report.environments.some(env => env.name === 'node')).toBeTruthy();
  expect(report.environments.some(env => env.name === 'browser')).toBeTruthy();
});

test('should have a reasonable name for default project', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'file.spec.ts': `
      import { test } from '@playwright/test';
      test('test', async () => { });
    `,
  });
  expect(report.environments.length).toBe(1);
  expect(report.environments[0].name).toBe('anonymous');
});
