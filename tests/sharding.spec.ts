import type { FlakinessReport } from '@flakiness/flakiness-report';
import { ReportUtils } from '@flakiness/sdk';
import { expect, test } from '@playwright/test';
import { runPerfectShards } from './utils.js';

test('should generate perfect shards', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('w=30 alpha', async () => {});
      test('w=10 beta', async () => {});
      test('w=10 gamma', async () => {});
      test('w=5 delta', async () => {});
      test('w=5 epsilon', async () => {});
    `,
  }, 2);

  expect(shards[0].totalWeight).toBe(30);
  expect(shards[1].totalWeight).toBe(30);
});

test('should generate perfect shards across independent projects', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('w=30 alpha', async () => {});
      test('w=10 beta', async () => {});
      test('w=10 gamma', async () => {});
      test('w=5 delta', async () => {});
      test('w=5 epsilon', async () => {});
    `,
  }, 2, {}, {
    projects: [
      { name: 'alpha' },
      { name: 'beta' },
    ],
  });

  expect(shards[0].totalWeight).toBe(60);
  expect(shards[1].totalWeight).toBe(60);
});

test('should shard tests without historical durations', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('alpha', async () => {});
      test('beta', async () => {});
      test('gamma', async () => {});
      test('delta', async () => {});
    `,
  }, 2);

  expect(shards.map(shard => shard.totalWeight)).toEqual([0, 0]);
  expect(shards.map(shard => reportTestCount(shard.report)).sort()).toEqual([2, 2]);
});

test('should keep repeatEach instances of one test in one shard', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('w=10 repeated', async () => {});
    `,
  }, 2, {}, {
    repeatEach: 2,
  });

  expect(shards.map(shard => shard.totalWeight).sort((a, b) => a - b)).toEqual([0, 20]);
  expect(shards.map(shard => reportTestCount(shard.report)).sort((a, b) => a - b)).toEqual([0, 2]);
});

test('should generate perfect shards with dependent projects', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'setup.spec.ts': `
      import { test } from '@playwright/test';

      test('w=100 setup', async () => {});
    `,
    'app.spec.ts': `
      import { test } from '@playwright/test';

      test('w=1 alpha', async () => {});
      test('w=1 beta', async () => {});
    `,
    'unit.spec.ts': `
      import { test } from '@playwright/test';

      for (let i = 0; i < 100; ++i)
        test('w=1 unit-test-' + i, async () => {});
    `,
  }, 2, {}, {
    projects: [
      { name: 'setup', testMatch: 'setup.spec.ts' },
      { name: 'app', testMatch: 'app.spec.ts', dependencies: ['setup'] },
      { name: 'unit', testMatch: 'unit.spec.ts', },
    ],
  });

  expect(shards.map(shard => shard.totalWeight)).toEqual([151, 151]);
});

test('should shard dependency projects selected with project filter', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'setup.spec.ts': `
      import { test } from '@playwright/test';

      test('w=30 setup alpha', async () => {});
      test('w=10 setup beta', async () => {});
    `,
    'app.spec.ts': `
      import { test } from '@playwright/test';

      test('w=100 app', async () => {});
    `,
  }, 2, {}, {
    projects: [
      { name: 'setup', testMatch: 'setup.spec.ts' },
      { name: 'app', testMatch: 'app.spec.ts', dependencies: ['setup'] },
    ],
  }, undefined, ['--project=setup']);

  expect(shards.map(shard => shard.totalWeight).sort((a, b) => a - b)).toEqual([10, 30]);
  expect(shards.map(shard => reportTestCount(shard.report)).sort((a, b) => a - b)).toEqual([1, 1]);
});

test('should generate perfect shards with teardown projects', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'setup.spec.ts': `
      import { test } from '@playwright/test';

      for (let i = 0; i < 40; ++i)
        test('w=1 setup-' + i, async () => {});
    `,
    'teardown.spec.ts': `
      import { test } from '@playwright/test';

      for (let i = 0; i < 60; ++i)
        test('w=1 teardown-' + i, async () => {});
    `,
    'app.spec.ts': `
      import { test } from '@playwright/test';

      for (let i = 0; i < 10; ++i)
        test('w=1 app-' + i, async () => {});
    `,
    'unit.spec.ts': `
      import { test } from '@playwright/test';

      for (let i = 0; i < 110; ++i)
        test('w=1 unit-' + i, async () => {});
    `,
  }, 2, {}, {
    projects: [
      { name: 'setup', testMatch: 'setup.spec.ts', teardown: 'teardown' },
      { name: 'teardown', testMatch: 'teardown.spec.ts' },
      { name: 'app', testMatch: 'app.spec.ts', dependencies: ['setup'] },
      { name: 'unit', testMatch: 'unit.spec.ts' },
    ],
  });

  // The best sharding here would be 110 / 110.
  expect(shards.map(shard => shard.totalWeight)).toEqual([160, 160]);
});

function reportTestCount(report: FlakinessReport.Report): number {
  let count = 0;
  ReportUtils.visitTests(report, test => count += test.attempts.length);
  return count;
}
