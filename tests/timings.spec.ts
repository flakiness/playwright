import { expect, test } from '@playwright/test';
import fs from 'fs';
import { generateFlakinessReport, reportTestCount, reportTestTitles, runBalancedShards } from './utils.js';

test('should balance shards using a --timings file instead of the Durations API', async ({}, testInfo) => {
  const files = {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('alpha', async () => { await new Promise(x => setTimeout(x, 100)); });
      test('beta', async () => {});
      test('gamma', async () => {});
      test('delta', async () => {});
    `,
  };

  // A previous run's report is a valid timings file. Build one with
  // `alpha` taking at least 100ms, while others are instant.
  const { report } = await generateFlakinessReport(testInfo, files, {}, { fullyParallel: true });
  const timingsFile = testInfo.outputPath('timings.json');
  fs.writeFileSync(timingsFile, JSON.stringify(report));

  const shards = await runBalancedShards(testInfo, files, 2, {}, { fullyParallel: true }, undefined, [`--timings=${timingsFile}`]);

  expect(shards.map(shard => reportTestCount(shard.report)).sort((a, b) => a - b)).toEqual([1, 3]);
  const soloShard = shards.find(shard => reportTestCount(shard.report) === 1)!;
  expect(reportTestTitles(soloShard.report)).toEqual(['alpha']);
});
