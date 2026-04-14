import { expect, test } from '@playwright/test';
import { assertCount, generateFlakinessReport } from './utils.js';

test('should attribute attachments to the step they belong to', async ({}, testInfo) => {
  const { report } = await generateFlakinessReport(testInfo, {
    'file.spec.ts': `
      import { test } from '@playwright/test';

      test('with attachment', async ({}, testInfo) => {
        await test.step('my-step', async () => {
          await testInfo.attach('my-attachment', { body: 'hello', contentType: 'text/plain' });
        });
      });
    `,
  });

  const [file] = assertCount(report.suites, 1);
  const [testCase] = assertCount(file.tests, 1);
  const [attempt] = assertCount(testCase.attempts, 1);

  const myStep = (attempt.steps ?? []).find(s => s.title === 'my-step');
  expect(myStep, 'my-step should exist').toBeDefined();

  // testInfo.attach creates a nested `attach` step under `my-step` that owns the attachment.
  const attachStep = (myStep!.steps ?? []).find(s => (s.attachments ?? []).length > 0);
  expect(attachStep, 'attach step should exist under my-step').toBeDefined();

  const [attachment] = assertCount(attachStep!.attachments, 1);
  expect(attachment.name).toBe('my-attachment');
  const [toplevelAttach] = assertCount(attempt.attachments, 1);
  expect(toplevelAttach.name).toBe('my-attachment');
});
