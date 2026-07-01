import { expect, test } from '@playwright/test';
import { assertCount, generateFlakinessReport } from './utils.js';

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

test('should only emit environments for projects that ran', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'file.spec.ts': `
      import { test } from '@playwright/test';
      test('test', async () => { });
    `,
  }, {}, {
    projects: [
      { name: 'alpha' },
      { name: 'beta' },
      { name: 'gamma' },
    ],
  }, {}, ['--project=beta']);

  expect(report.environments.map(e => e.name)).toEqual(['beta']);

  const [file] = assertCount(report.suites, 1);
  const [t] = assertCount(file.tests, 1);
  const [attempt] = assertCount(t.attempts, 1);
  expect(attempt.environmentIdx ?? 0).toBe(0);
});

test('should generate report with no environments when no project ran', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'file.spec.ts': `
      import { test } from '@playwright/test';
      // no tests
    `,
  }, {}, {
    projects: [
      { name: 'alpha' },
      { name: 'beta' },
    ],
  });

  expect(report.environments.length).toBe(0);
});

test('should propagate FK_ENV_* variables into environment metadata', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'file.spec.ts': `
      import { test } from '@playwright/test';
      test('test', async () => { });
    `,
  }, {}, {}, {
    FK_ENV_FOO: 'bar',
  });
  expect(report.environments.length).toBe(1);
  const [env] = report.environments;
  expect(env.metadata?.foo).toBe('bar');
  expect(env.metadata).not.toHaveProperty('actualWorkers');
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

test('should give unique environment names to multiple anonymous projects', async ({}, testInfo) => {
  // Each Playwright project maps to a distinct Flakiness environment, and the
  // environment name is the first component of a test's id. If two projects
  // shared an environment name, their tests would collapse onto the same id.
  const { report } = await generateFlakinessReport(testInfo, {
    'file.spec.ts': `
      import { test } from '@playwright/test';
      test('test', async () => { });
    `,
  }, {}, {
    projects: [{}, {}, {}],
  });
  expect(report.environments.length).toBe(3);
  const names = report.environments.map(env => env.name);
  expect(new Set(names).size).toBe(names.length);
  expect(names).toEqual(['anonymous', 'anonymous-2', 'anonymous-3']);
});
