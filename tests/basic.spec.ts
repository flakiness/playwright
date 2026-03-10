import { test, expect } from '@playwright/test';
import { generateFlakinessReport } from './utils';

test('should report proper top-level properties', async ({}, testInfo) => {
  const starttime = Date.now();
  const { report, log } = await generateFlakinessReport(testInfo, {
    'example.spec.ts': `
      import { test, expect } from '@playwright/test';

      test('should work', async () => {
        expect(1 + 1).toBe(2);
      });
    `,
  }, {
    flakinessProject: 'foo/bar',
  });
  expect(report.category).toBe('playwright');
  expect(report.flakinessProject).toBe('foo/bar');
  expect(report.commitId).not.toBeUndefined();
  expect(report.configPath).toBe('playwright.config.ts');
  expect(report.duration).toBeGreaterThan(0);
  expect(report.startTimestamp).toBeGreaterThanOrEqual(starttime);
  // CPU telemetry
  expect(report.cpuCount).toBeGreaterThan(0);
  expect(report.cpuMax?.length).toBeGreaterThan(0);
  expect(report.cpuAvg?.length).toBeGreaterThan(0);
  // RAM telemetry
  expect(report.ramBytes).toBeGreaterThan(0);
  expect(report.ram?.length).toBeGreaterThan(0);

  // A message on how to show flakiness report should be shown
  expect(log.stdout).toContain('npx flakiness show');
});
