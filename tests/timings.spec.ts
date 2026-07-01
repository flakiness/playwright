import { FlakinessReport } from '@flakiness/flakiness-report';
import { ReportUtils } from '@flakiness/sdk';
import { expect, test } from '@playwright/test';
import fs from 'fs';
import { DEFAULT_DURATION } from '../src/sharding.js';
import { generateFlakinessReport, reportTestCount, reportTestTitles, runBalancedShardRaw, runBalancedShards } from './utils.js';

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

test('should fallback to durations when env name does not match', async ({}, testInfo) => {
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
  };

  const { report } = await generateFlakinessReport(testInfo, files, {}, playwrightConfig);
  const weights: Record<string, number> = {
    'alpha': 100_000,
    'beta': 1,
    'gamma': 1,
    'delta': 1,
  };
  ReportUtils.visitTests(report, t => {
    for (const attempt of t.attempts)
      attempt.duration = weights[t.title] as FlakinessReport.DurationMS;
  });
  // Amend environments so that timings are recorded for some weird env.
  report.environments = [{
    name: 'very unusual name',
    systemData: {
      osArch: 'nonexistent',
      osName: 'weirdos',
      osVersion: '2.2.22',
    },
  }];
  const timingsFile = testInfo.outputPath('timings.json');
  fs.writeFileSync(timingsFile, JSON.stringify(report));

  // Make sure that sharding still uses the duration hints despite the unusual environment.
  const shards = await runBalancedShards(testInfo, files, 2, {}, playwrightConfig, undefined, [
    `--timings=${timingsFile}`,
  ]);
  expect(shards.map(shard => reportTestCount(shard.report)).sort((a, b) => a - b)).toEqual([1, 3]);
});

test('should still shard when there are new tests', async ({}, testInfo) => {
  const playwrightConfig = { fullyParallel: true };
  const { report } = await generateFlakinessReport(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('alpha', async () => {});
    `,
  }, {}, playwrightConfig);
  const weights: Record<string, number> = {
    'alpha': 100_000,
  };
  ReportUtils.visitTests(report, t => {
    for (const attempt of t.attempts)
      attempt.duration = weights[t.title] as FlakinessReport.DurationMS;
  });
  const timingsFile = testInfo.outputPath('timings.json');
  fs.writeFileSync(timingsFile, JSON.stringify(report));

  // Add new tests that haven't been seen before; make sure
  // shard balancing works with them.
  const shards = await runBalancedShards(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('alpha', async () => {});
      test('beta', async () => {});
      test('gamma', async () => {});
      test('delta', async () => {});
    `,
  }, 2, {}, playwrightConfig, undefined, [
    `--timings=${timingsFile}`,
  ]);
  expect(shards.map(shard => reportTestCount(shard.report)).sort((a, b) => a - b)).toEqual([1, 3]);
});

test('should accumulate retries when estimating test duration', async ({}, testInfo) => {
  const playwrightConfig = { fullyParallel: true };
  const { report } = await generateFlakinessReport(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('alpha', async () => {});
    `,
  }, {}, playwrightConfig);
  // Synthesize the report with 10 retries, each with DEFAULT_DURATION duration.
  ReportUtils.visitTests(report, t => {
    t.attempts = [];
    for (let i = 0; i < 10; ++i) {
      t.attempts.push({
        startTimestamp: 0 as FlakinessReport.UnixTimestampMS,
        duration: DEFAULT_DURATION as FlakinessReport.DurationMS,
      });
    }
  });
  const timingsFile = testInfo.outputPath('timings.json');
  fs.writeFileSync(timingsFile, JSON.stringify(report));

  // Add new tests that haven't been seen before; they still all hit the other shard, since
  // the one test we have takes 10 retries and will fully occupy one of the shards.
  const shards = await runBalancedShards(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('alpha', async () => {});
      test('beta', async () => {});
      test('gamma', async () => {});
      test('delta', async () => {});
    `,
  }, 2, {}, playwrightConfig, undefined, [
    `--timings=${timingsFile}`,
  ]);
  expect(shards.map(shard => reportTestCount(shard.report)).sort((a, b) => a - b)).toEqual([1, 3]);
});

test('should fail with a clear message when the --timings file is missing', async ({}, testInfo) => {
  const files = {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('alpha', async () => {});
    `,
  };
  const missing = testInfo.outputPath('does-not-exist.json');
  const { exitCode, stderr } = await runBalancedShardRaw(testInfo, files, '1/2', {}, { fullyParallel: true }, undefined, [
    `--timings=${missing}`,
  ]);
  expect(exitCode).not.toBe(0);
  // The error must point at the timings file, not at some unrelated cause.
  expect(stderr).toContain('--timings file');
  expect(stderr).toContain(missing);
});

test('should fail with a clear message when the --timings file is malformed', async ({}, testInfo) => {
  const files = {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('alpha', async () => {});
    `,
  };
  const badTimings = testInfo.outputPath('bad-timings.json');
  fs.writeFileSync(badTimings, 'this is not valid json {{{');
  const { exitCode, stderr } = await runBalancedShardRaw(testInfo, files, '1/2', {}, { fullyParallel: true }, undefined, [
    `--timings=${badTimings}`,
  ]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain('--timings file');
  console.log(stderr);
  expect(stderr).toMatch(/JSON|parse/i);
});
