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

test('should keep tests from serial suites in one shard', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test.describe.serial('serial group', () => {
        test('w=7 alpha', async () => {});
        test('w=1 beta', async () => {});
        test('w=6 gamma', async () => {});
        test('w=2 delta', async () => {});
        test('w=5 epsilon', async () => {});
        test('w=3 zeta', async () => {});
        test('w=4 eta', async () => {});
      });
    `,
  }, 2);

  // All serial tests should end up in the same shard.
  expect(shards.map(shard => shard.totalWeight)).toEqual([28, 0]);
  // Make sure tests inside shard groups retain their order.
  expect(reportTestTitles(shards[0].report)).toEqual([
    'w=7 alpha',
    'w=1 beta',
    'w=6 gamma',
    'w=2 delta',
    'w=5 epsilon',
    'w=3 zeta',
    'w=4 eta',
  ]);
});

test('should keep serial suite tests together while sharding standalone tests', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('w=8 standalone alpha', async () => {});

      test.describe.serial('serial group', () => {
        test('w=5 serial alpha', async () => {});
        test('w=5 serial beta', async () => {});
      });

      test('w=8 standalone beta', async () => {});
      test('w=8 standalone gamma', async () => {});
    `,
  }, 2);

  // Playwright's --test-list selects tests, but does not preserve list order.
  expect(shards.map(shard => reportTestTitles(shard.report).sort())).toEqual([
    [
      'w=5 serial alpha',
      'w=5 serial beta',
      'w=8 standalone gamma',
    ],
    [
      'w=8 standalone alpha',
      'w=8 standalone beta',
    ],
  ]);
});

test('should keep nested tests from configured serial suites in one shard', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test.describe('configured serial group', () => {
        test.describe.configure({ mode: 'serial' });

        test('w=3 serial outer', async () => {});
        test.describe('nested group', () => {
          test('w=9 serial nested', async () => {});
        });
      });

      test('w=10 standalone alpha', async () => {});
      test('w=10 standalone beta', async () => {});
    `,
  }, 2);

  expect(shards.map(shard => reportTestTitles(shard.report))).toEqual([
    [
      'w=3 serial outer',
      'w=9 serial nested',
    ],
    [
      'w=10 standalone alpha',
      'w=10 standalone beta',
    ],
  ]);
});

test('should reject reporter override for balanced sharding', async ({}, testInfo) => {
  await expect(runPerfectShards(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('w=10 alpha', async () => {});
    `,
  }, 2, {}, {}, undefined, ['--reporter=line'])).rejects.toThrow(/disable @flakiness\/playwright/);
});

test('should reject Playwright shard argument for balanced sharding', async ({}, testInfo) => {
  await expect(runPerfectShards(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('w=10 alpha', async () => {});
    `,
  }, 2, {}, {}, undefined, ['--', '--shard=1/2'])).rejects.toThrow(/managed by flakiness-playwright-shard/);
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

  // Splitting the two cheap "app" tests across both shards would run the heavy
  // w=100 setup twice (151 / 151). Instead we keep them together so setup runs
  // once, and balance the 100 unit tests around it: 100 (setup + 2 app) vs 100
  // units.
  expect(shards.map(shard => shard.totalWeight)).toEqual([102, 100]);
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

  // The setup (40) + teardown (60) only pay off when the 10 app tests stay on
  // one shard: that shard runs setup + app + teardown = 110, while the other
  // shard runs all 110 unit tests = 110. Splitting app would duplicate the
  // 100-weight setup/teardown and yield 160 / 160.
  expect(shards.map(shard => shard.totalWeight)).toEqual([110, 110]);
});

test('should spread a heavy dependent project across shards', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'setup.spec.ts': `
      import { test } from '@playwright/test';

      test('w=100 setup', async () => {});
    `,
    'app.spec.ts': `
      import { test } from '@playwright/test';

      for (let i = 0; i < 400; ++i)
        test('w=1 app-' + i, async () => {});
    `,
  }, 2, {}, {
    projects: [
      { name: 'setup', testMatch: 'setup.spec.ts' },
      { name: 'app', testMatch: 'app.spec.ts', dependencies: ['setup'] },
    ],
  });

  // The app work (400) dwarfs the setup (100), so paying setup twice is worth
  // it: each shard runs setup (100) + 200 app tests = 300, beating the
  // keep-together makespan of 500.
  expect(shards.map(shard => shard.totalWeight)).toEqual([300, 300]);
  expect(shards.map(shard => reportTestCount(shard.report)).sort((a, b) => a - b)).toEqual([201, 201]);
});

function reportTestCount(report: FlakinessReport.Report): number {
  let count = 0;
  ReportUtils.visitTests(report, test => count += test.attempts.length);
  return count;
}

function reportTestTitles(report: FlakinessReport.Report): string[] {
  const titles: string[] = [];
  ReportUtils.visitTests(report, test => {
    for (const _attempt of test.attempts)
      titles.push(test.title);
  });
  return titles;
}
