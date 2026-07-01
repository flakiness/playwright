import { expect, test } from '@playwright/test';
import { generateFlakinessReport, runBalancedShards } from './utils.js';

test('should default the report title to the shard slot', async ({}, testInfo) => {
  const shards = await runBalancedShards(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('alpha', async () => {});
      test('beta', async () => {});
    `,
  }, 2);

  expect(shards.map(shard => shard.report.title)).toEqual(['Shard 1/2', 'Shard 2/2']);
});

test('should let an explicit title override the shard slot', async ({}, testInfo) => {
  const shards = await runBalancedShards(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('alpha', async () => {});
      test('beta', async () => {});
    `,
  }, 2, { title: 'My run' });

  expect(shards.map(shard => shard.report.title)).toEqual(['My run', 'My run']);
});

test('should let FLAKINESS_TITLE override the shard slot', async ({}, testInfo) => {
  const shards = await runBalancedShards(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('alpha', async () => {});
      test('beta', async () => {});
    `,
  }, 2, {}, {}, { FLAKINESS_TITLE: 'From env' });

  expect(shards.map(shard => shard.report.title)).toEqual(['From env', 'From env']);
});

test('should default the report title to the native Playwright shard slot', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('alpha', async () => {});
      test('beta', async () => {});
      test('gamma', async () => {});
      test('delta', async () => {});
    `,
  }, {}, {}, {}, ['--shard=1/2']);

  expect(report.title).toBe('Shard 1/2');
});
