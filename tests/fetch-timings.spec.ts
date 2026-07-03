import { FlakinessReport } from '@flakiness/flakiness-report';
import { ReportUtils } from '@flakiness/sdk';
import { expect, test } from '@playwright/test';
import { fetchTimings } from './utils.js';

test('fetches per-environment durations and distills them into a timings report', async ({}, testInfo) => {
  const files = {
    'a.spec.ts': `
      import { test } from '@playwright/test';
      // The fake Durations server reads the weight encoded in the title:
      // 100ms everywhere, except 50ms in "firefox".
      test('alpha w=100 w[firefox]=50', async () => {});
    `,
  };
  const { exitCode, timings } = await fetchTimings(testInfo, files, {
    projects: [{ name: 'chromium' }, { name: 'firefox' }],
  });

  expect(exitCode).toBe(0);
  expect(timings?.environments).toEqual([{ name: 'chromium' }, { name: 'firefox' }]);

  // A real `--list` report nests tests under the file suite, so walk the tree.
  const tests: FlakinessReport.Test[] = [];
  ReportUtils.visitTests(timings!, t => tests.push(t));
  expect(tests).toEqual([{
    title: 'alpha w=100 w[firefox]=50',
    attempts: [
      { duration: 100 },                   // chromium (env 0, index elided)
      { environmentIdx: 1, duration: 50 },  // firefox
    ],
  }]);
});

test('fails loudly when durations cannot be produced', async ({}, testInfo) => {
  const files = {
    'a.spec.ts': `
      import { test } from '@playwright/test';
      test('alpha', async () => {});
    `,
  };
  // No token and no flakinessProject: the Durations API cannot identify the
  // project, so the reporter errors and no timings file is written. `fetch` must
  // surface that as a non-zero exit rather than silently emitting nothing.
  const { exitCode, timings } = await fetchTimings(testInfo, files, {}, { auth: false });

  expect(exitCode).not.toBe(0);
  expect(timings).toBeUndefined();
});

test('does not pass off a pre-existing output file as this run\'s result', async ({}, testInfo) => {
  const files = {
    'a.spec.ts': `
      import { test } from '@playwright/test';
      test('alpha', async () => {});
    `,
    // A leftover timings file from a previous run, sitting at the output path.
    'timings.json': `{ "stale": true }`,
  };
  // Same failure mode as above: the reporter errors and writes nothing. The
  // stale file at the output path must not turn that into a success.
  const { exitCode, timings } = await fetchTimings(testInfo, files, {}, { auth: false });

  expect(exitCode).not.toBe(0);
  expect(timings).toEqual({ stale: true });
});
