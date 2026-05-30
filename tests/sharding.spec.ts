import type { FlakinessReport } from '@flakiness/flakiness-report';
import { ReportUtils } from '@flakiness/sdk';
import { expect, test } from '@playwright/test';
import { runPerfectShards } from './utils.js';

test('should generate perfect shards', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('w=30 alpha', async () => {});
      test('w=10 beta', async () => {});
      test('w=10 gamma', async () => {});
      test('w=5 delta', async () => {});
      test('w=5 epsilon', async () => {});
    `,
  }, 2);

  expect(shards[0].totalWeight).toBe(30);
  expect(shards[1].totalWeight).toBe(30);
});

test('should generate perfect shards across independent projects', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('w=30 alpha', async () => {});
      test('w=10 beta', async () => {});
      test('w=10 gamma', async () => {});
      test('w=5 delta', async () => {});
      test('w=5 epsilon', async () => {});
    `,
  }, 2, {}, {
    projects: [
      { name: 'alpha' },
      { name: 'beta' },
    ],
  });

  expect(shards[0].totalWeight).toBe(60);
  expect(shards[1].totalWeight).toBe(60);
});

test('should shard tests without historical durations', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('alpha', async () => {});
      test('beta', async () => {});
      test('gamma', async () => {});
      test('delta', async () => {});
    `,
  }, 2);

  expect(shards.map(shard => shard.totalWeight)).toEqual([0, 0]);
  expect(shards.map(shard => reportTestCount(shard.report)).sort()).toEqual([2, 2]);
});

function reportTestCount(report: FlakinessReport.Report): number {
  let count = 0;
  ReportUtils.visitTests(report, test => count += test.attempts.length);
  return count;
}
