import { FlakinessReport } from '@flakiness/flakiness-report';
import { expect, test } from '@playwright/test';
import { distillTimings } from '../src/timings.js';

function fillRequired(spec: Partial<FlakinessReport.Report>): FlakinessReport.Report {
  return {
    environments: [],
    category: 'playwright',
    commitId: 'commit' as FlakinessReport.CommitId,
    duration: 0 as FlakinessReport.DurationMS,
    startTimestamp: 0 as FlakinessReport.UnixTimestampMS,
    ...spec,
  };
}

test('keeps a single test duration in a single environment', () => {
  const report = fillRequired({
    environments: [{ name: 'chromium' }],
    tests: [{
      title: 'alpha',
      attempts: [{ duration: 100 as FlakinessReport.DurationMS }]
    }],
  });
  const timings = distillTimings([report]);
  expect(timings.tests?.[0]).toEqual({
    title: 'alpha',
    attempts: [{
      duration: 100,
    }]
  })
});

test('sums retries of a test within a single report', () => {
  const report = fillRequired({
    environments: [{ name: 'chromium' }],
    tests: [{
      title: 'alpha',
      attempts: [
        { duration: 50 as FlakinessReport.DurationMS },
        { duration: 50 as FlakinessReport.DurationMS },
      ],
    }],
  });
  const timings = distillTimings([report]);
  expect(timings.tests?.[0]).toEqual({
    title: 'alpha',
    attempts: [{
      duration: 100,
    }]
  })
});

test('takes the max duration across reports for the same environment', () => {
  const reportA = fillRequired({
    environments: [{ name: 'chromium' }],
    tests: [{
      title: 'alpha',
      attempts: [{ duration: 100 as FlakinessReport.DurationMS }],
    }],
  });
  const reportB = fillRequired({
    environments: [{ name: 'chromium' }],
    tests: [{
      title: 'alpha',
      attempts: [{ duration: 120 as FlakinessReport.DurationMS }],
    }],
  });
  const timings = distillTimings([reportA, reportB]);
  expect(timings.tests?.[0]).toEqual({
    title: 'alpha',
    attempts: [{
      duration: 120,
    }]
  })
});

test('merges same-named environments across reports even when their metadata/system differs', () => {
  const reportA = fillRequired({
    environments: [{
      name: 'chromium',
      systemData: { osName: 'windows' },
      metadata: { actualWorkers: 4 },
    }],
    tests: [{
      title: 'alpha',
      attempts: [{ duration: 100 as FlakinessReport.DurationMS }],
    }],
  });
  const reportB = fillRequired({
    environments: [{
      name: 'chromium',
      systemData: { osName: 'linux' },
      metadata: { actualWorkers: 8 }
    }],
    tests: [{
      title: 'alpha',
      attempts: [{ duration: 120 as FlakinessReport.DurationMS }],
    }],
  });
  const timings = distillTimings([reportA, reportB]);
  // Matching only relies on environment name, so the two `chromium` runs collapse
  // into a single, metadata-free environment.
  expect(timings.environments).toEqual([{ name: 'chromium' }]);
  expect(timings.tests?.[0]).toEqual({
    title: 'alpha',
    attempts: [{
      duration: 120,
    }]
  });
});

test('keeps distinct environments across reports, each attributed correctly', () => {
  const reportA = fillRequired({
    environments: [{ name: 'chromium' }],
    tests: [{
      title: 'alpha',
      attempts: [{ duration: 100 as FlakinessReport.DurationMS }],
    }],
  });
  const reportB = fillRequired({
    environments: [{ name: 'firefox' }],
    tests: [{
      title: 'alpha',
      attempts: [{ duration: 120 as FlakinessReport.DurationMS }],
    }],
  });
  const timings = distillTimings([reportA, reportB]);
  expect(timings.environments).toEqual([
    { name: 'chromium' },
    { name: 'firefox' },
  ]);
  expect(timings.tests?.[0]).toEqual({
    title: 'alpha',
    attempts: [
      { duration: 100 },
      { environmentIdx: 1, duration: 120 },
    ],
  });
});

test('sums retries within a run, then takes the max across runs', () => {
  const reportA = fillRequired({
    environments: [{ name: 'chromium' }],
    tests: [{
      title: 'alpha',
      attempts: [
        { duration: 50 as FlakinessReport.DurationMS },
        { duration: 50 as FlakinessReport.DurationMS },
      ],
    }],
  });
  const reportB = fillRequired({
    environments: [{ name: 'chromium' }],
    tests: [{
      title: 'alpha',
      attempts: [{ duration: 80 as FlakinessReport.DurationMS }],
    }],
  });
  const timings = distillTimings([reportA, reportB]);
  // Run A: 50 + 50 = 100 (retries summed). Run B: 80. Across runs: max(100, 80) = 100.
  expect(timings.tests?.[0]).toEqual({
    title: 'alpha',
    attempts: [{
      duration: 100,
    }]
  });
});

test('collapses to a single attempt when every environment shares one duration', () => {
  const report = fillRequired({
    environments: [{ name: 'chromium' }, { name: 'firefox' }],
    tests: [{
      title: 'alpha',
      attempts: [
        { environmentIdx: 0, duration: 100 as FlakinessReport.DurationMS },
        { environmentIdx: 1, duration: 100 as FlakinessReport.DurationMS },
      ],
    }],
  });
  const timings = distillTimings([report]);
  // Normalizer does not drop environments without attempts, 
  // so we still end up with 2 environments for now. This is not critical.
  expect(timings.environments).toEqual([
    { name: 'chromium' },
    { name: 'firefox' },
  ]);
  // Both environments cost the same, so we keep a single attempt; the consumer's
  // max-fallback covers `firefox`, which no longer has its own attempt.
  expect(timings.tests?.[0]).toEqual({
    title: 'alpha',
    attempts: [{
      duration: 100,
    }]
  });
});

test('keeps a per-environment attempt when durations differ', () => {
  const report = fillRequired({
    environments: [{ name: 'chromium' }, { name: 'firefox' }],
    tests: [{
      title: 'alpha',
      attempts: [
        { environmentIdx: 0, duration: 100 as FlakinessReport.DurationMS },
        { environmentIdx: 1, duration: 200 as FlakinessReport.DurationMS },
      ],
    }],
  });
  const timings = distillTimings([report]);
  // Durations differ per environment, so both attempts survive.
  expect(timings.environments).toEqual([{ name: 'chromium' }, { name: 'firefox' }]);
  expect(timings.tests?.[0]).toEqual({
    title: 'alpha',
    attempts: [
      { duration: 100 },
      { environmentIdx: 1, duration: 200 },
    ],
  });
});

test('drops attempts without a recorded duration', () => {
  const report = fillRequired({
    environments: [{ name: 'chromium' }],
    tests: [{
      title: 'alpha',
      attempts: [
        { duration: 100 as FlakinessReport.DurationMS },
        {}, // e.g. an attempt that never produced a duration
      ],
    }],
  });
  const timings = distillTimings([report]);
  // The duration-less attempt is ignored; it does not add 0 to the sum.
  expect(timings.tests?.[0]).toEqual({
    title: 'alpha',
    attempts: [{
      duration: 100,
    }]
  });
});

test('unions tests seen across different reports', () => {
  const reportA = fillRequired({
    environments: [{ name: 'chromium' }],
    tests: [{
      title: 'alpha',
      attempts: [{ duration: 100 as FlakinessReport.DurationMS }],
    }],
  });
  const reportB = fillRequired({
    environments: [{ name: 'chromium' }],
    tests: [{
      title: 'beta',
      attempts: [{ duration: 200 as FlakinessReport.DurationMS }],
    }],
  });
  const timings = distillTimings([reportA, reportB]);
  expect(timings.tests).toEqual([
    { title: 'alpha', attempts: [{ duration: 100 }] },
    { title: 'beta', attempts: [{ duration: 200 }] },
  ]);
});
