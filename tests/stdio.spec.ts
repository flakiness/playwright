import { FlakinessReport } from '@flakiness/flakiness-report';
import { expect, test } from '@playwright/test';
import { assertCount, assertStdioEntry, generateFlakinessReport } from './utils.js';

test('should serialize interleaved stdio in chronological order', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('interleaved output', async () => {
        console.log('first');
        console.error('second');
        console.log('third');
        console.error('forth');
      });
    `,
  });

  const attempt = report.suites![0]!.tests![0]!.attempts[0];
  // Deprecated per-stream fields should not be set.
  expect(attempt.stdout).toBeUndefined();
  expect(attempt.stderr).toBeUndefined();
  // Entries appear in write order, not grouped by stream. `stream` is omitted for stdout (default).
  const [first, second, third, forth] = assertCount(attempt.stdio, 4);
  assertStdioEntry(first, 'first\n', FlakinessReport.STREAM_STDOUT);
  assertStdioEntry(second, 'second\n', FlakinessReport.STREAM_STDERR);
  assertStdioEntry(third, 'third\n', FlakinessReport.STREAM_STDOUT);
  assertStdioEntry(forth, 'forth\n', FlakinessReport.STREAM_STDERR);
});

test('should have valid timestamps in stdio entries', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('timed output', async () => {
        console.log('before delay');
        await new Promise(r => setTimeout(r, 100));
        console.log('after delay');
      });
    `,
  });

  const attempt = report.suites![0]!.tests![0]!.attempts[0];
  const [first, second] = assertCount(attempt.stdio, 2);
  expect(first.dts).toBeGreaterThanOrEqual(0);
  expect(second.dts).toBeGreaterThanOrEqual(100);
});
