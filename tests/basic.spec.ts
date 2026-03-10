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

test('should report stdio', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'example.spec.ts': `
      import { test, expect } from '@playwright/test';

      test('stdio test', async () => {
        console.log('stdout message');
        console.error('stderr message');
        expect(1 + 1).toBe(2);
      });
    `,
  });

  const attempt = report.suites![0]!.tests![0]!.attempts[0];
  // stdout and stderr should not be set (deprecated)
  expect(attempt.stdout).toBeUndefined();
  expect(attempt.stderr).toBeUndefined();
  // stdio should be a single ordered array
  expect(attempt.stdio).toHaveLength(2);
  expect((attempt.stdio![0] as any).text).toContain('stdout message');
  expect(attempt.stdio![0]!.stream ?? 1).toBe(1); // stdout (stream omitted = default)
  expect(typeof attempt.stdio![0]!.dts).toBe('number');
  expect((attempt.stdio![1] as any).text).toContain('stderr message');
  expect(attempt.stdio![1]!.stream).toBe(2); // stderr
  expect(typeof attempt.stdio![1]!.dts).toBe('number');
});

test('should preserve chronological order of interleaved stdio', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'example.spec.ts': `
      import { test, expect } from '@playwright/test';

      test('interleaved output', async () => {
        console.log('first');
        console.error('second');
        console.log('third');
        console.error('fourth');
      });
    `,
  });

  const attempt = report.suites![0]!.tests![0]!.attempts[0];
  expect(attempt.stdio).toHaveLength(4);
  // Verify chronological ordering — entries should appear in the order they were written,
  // not grouped by stream.
  expect((attempt.stdio![0] as any).text).toContain('first');
  expect(attempt.stdio![0]!.stream ?? 1).toBe(1); // stdout (stream omitted = default)
  expect((attempt.stdio![1] as any).text).toContain('second');
  expect(attempt.stdio![1]!.stream).toBe(2); // stderr
  expect((attempt.stdio![2] as any).text).toContain('third');
  expect(attempt.stdio![2]!.stream ?? 1).toBe(1); // stdout (stream omitted = default)
  expect((attempt.stdio![3] as any).text).toContain('fourth');
  expect(attempt.stdio![3]!.stream).toBe(2); // stderr
});

test('should have valid timestamps in stdio entries', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'example.spec.ts': `
      import { test, expect } from '@playwright/test';

      test('timed output', async () => {
        console.log('before delay');
        await new Promise(r => setTimeout(r, 100));
        console.log('after delay');
      });
    `,
  });

  const attempt = report.suites![0]!.tests![0]!.attempts[0];
  expect(attempt.stdio).toHaveLength(2);
  // All dts values should be non-negative
  for (const entry of attempt.stdio!) {
    expect(entry.dts).toBeGreaterThanOrEqual(0);
  }
  // The sum of all dts deltas should be roughly within the test duration.
  // We allow some margin because dts is measured in the reporter process
  // while duration is measured in the worker process (IPC adds latency).
  const totalDts = attempt.stdio!.reduce((sum, entry) => sum + entry.dts, 0);
  expect(totalDts).toBeLessThanOrEqual(attempt.duration! + 500);
  // Second entry should have dts >= 50ms (we waited 100ms, allow some margin)
  expect(attempt.stdio![1]!.dts).toBeGreaterThanOrEqual(50);
});

