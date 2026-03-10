import { test, expect } from '@playwright/test';
import { assertCount, generateFlakinessReport } from './utils';

test('should capture stdio', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'file-1.spec.ts': `
      import { test } from '@playwright/test';

      test('test-1', async () => {
        console.log('foo');
        console.error('bar');
      });
    `,
  });
  const [file] = assertCount(report.suites, 1);
  const [test1] = assertCount(file.tests, 1);
  const [attempt] = assertCount(test1.attempts, 1);

  const [stdoutEntry] = assertCount(attempt.stdout, 1);
  expect((stdoutEntry as any).text).toBe('foo\n');

  const [stderrEntry] = assertCount(attempt.stderr, 1);
  expect((stderrEntry as any).text).toBe('bar\n');
});
