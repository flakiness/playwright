import { FlakinessReport } from '@flakiness/flakiness-report';
import { ReportUtils } from '@flakiness/sdk';
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

test('should balance shards using per-environment durations from a --timings file', async ({}, testInfo) => {
  const files = {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('alpha', async () => {});
      test('beta', async () => {});
      test('gamma', async () => {});
      test('delta', async () => {});
    `,
  };
  const playwrightConfig = {
    fullyParallel: true,
    projects: [{ name: 'fast' }, { name: 'slow' }],
  };

  // Amend durations for the real report:
  // - in "slow" project, one test is very slow, others are fast.
  // - in "fast" project, everyone is fast.
  const { report } = await generateFlakinessReport(testInfo, files, {}, playwrightConfig);
  const weights: Record<string, number> = {
    'slow:alpha': 100_000,
    'slow:beta': 1,
    'slow:gamma': 1,
    'slow:delta': 1,
    'fast:alpha': 1,
    'fast:beta': 1,
    'fast:gamma': 1,
    'fast:delta': 1,
  };
  ReportUtils.visitTests(report, t => {
    for (const attempt of t.attempts) {
      const envName = report.environments[attempt.environmentIdx ?? 0].name;
      attempt.duration = weights[`${envName}:${t.title}`] as FlakinessReport.DurationMS;
    }
  });
  const timingsFile = testInfo.outputPath('timings.json');
  fs.writeFileSync(timingsFile, JSON.stringify(report));

  // Now, when sharding only the slow tests, we expect to see 1:3 split
  const slowShards = await runBalancedShards(testInfo, files, 2, {}, playwrightConfig, undefined, [
    `--timings=${timingsFile}`,
    `--project=slow`,
  ]);
  expect(slowShards.map(shard => reportTestCount(shard.report)).sort((a, b) => a - b)).toEqual([1, 3]);
  // Now, when sharding only the fast tests, we expect to see 2:2 split
  const fastShards = await runBalancedShards(testInfo, files, 2, {}, playwrightConfig, undefined, [
    `--timings=${timingsFile}`,
    `--project=fast`,
  ]);
  expect(fastShards.map(shard => reportTestCount(shard.report)).sort((a, b) => a - b)).toEqual([2, 2]);
});
