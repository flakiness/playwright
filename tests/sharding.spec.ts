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

  // Both app tests consolidate on one shard, paying the heavy setup once;
  // unit tests fill the other shard.
  expect(shards.map(shard => shard.totalWeight)).toEqual([102, 100]);
  expect(shards.map(shard => reportTestCount(shard.report))).toEqual([3, 100]);
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

  // App tests consolidate on one shard together with their setup and teardown
  // (40 + 60 + 10), unit tests fill the other shard to the same 110.
  expect(shards.map(shard => shard.totalWeight)).toEqual([110, 110]);
});

test('should pay setup cost once when independent tests can fill other shards', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'setup.spec.ts': `
      import { test } from '@playwright/test';

      test('w=100 setup', async () => {});
    `,
    'app.spec.ts': `
      import { test } from '@playwright/test';

      test('w=5 app alpha', async () => {});
      test('w=5 app beta', async () => {});
      test('w=5 app gamma', async () => {});
      test('w=5 app delta', async () => {});
    `,
    'unit.spec.ts': `
      import { test } from '@playwright/test';

      for (let i = 0; i < 120; ++i)
        test('w=1 unit-' + i, async () => {});
    `,
  }, 2, {}, {
    projects: [
      { name: 'setup', testMatch: 'setup.spec.ts' },
      { name: 'app', testMatch: 'app.spec.ts', dependencies: ['setup'] },
      { name: 'unit', testMatch: 'unit.spec.ts' },
    ],
  });

  // All app tests stay with their setup on one shard (100 + 4×5 = 120),
  // and the unit tests fill the other shard to the same 120.
  expect(shards.map(shard => shard.totalWeight)).toEqual([120, 120]);
  expect(shards.map(shard => reportTestCount(shard.report))).toEqual([5, 120]);
});

test('should duplicate setup across shards when dependent tests dominate', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'setup.spec.ts': `
      import { test } from '@playwright/test';

      test('w=10 setup', async () => {});
    `,
    'app.spec.ts': `
      import { test } from '@playwright/test';

      for (let i = 0; i < 20; ++i)
        test('w=10 app-' + i, async () => {});
    `,
  }, 2, {}, {
    projects: [
      { name: 'setup', testMatch: 'setup.spec.ts' },
      { name: 'app', testMatch: 'app.spec.ts', dependencies: ['setup'] },
    ],
  });

  // Keeping all 200s of app tests on one shard would yield 210 / 0; re-running
  // the cheap 10s setup on both shards is well worth it: 10 + 10×10 each.
  expect(shards.map(shard => shard.totalWeight)).toEqual([110, 110]);
  expect(shards.map(shard => reportTestCount(shard.report))).toEqual([11, 11]);
});

test('should share one setup across browser projects on every shard', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'setup.spec.ts': `
      import { test } from '@playwright/test';

      test('w=60 setup', async () => {});
    `,
    'app.spec.ts': `
      import { test } from '@playwright/test';

      test('w=30 app alpha', async () => {});
      test('w=30 app beta', async () => {});
    `,
  }, 3, {}, {
    projects: [
      { name: 'setup', testMatch: 'setup.spec.ts' },
      { name: 'chromium', testMatch: 'app.spec.ts', dependencies: ['setup'] },
      { name: 'firefox', testMatch: 'app.spec.ts', dependencies: ['setup'] },
      { name: 'webkit', testMatch: 'app.spec.ts', dependencies: ['setup'] },
    ],
  });

  // All browser tests need the setup, so every shard pays for it once and
  // takes an equal slice of the browser tests: 60 + 2×30 each.
  expect(shards.map(shard => shard.totalWeight)).toEqual([120, 120, 120]);
  expect(shards.map(shard => reportTestCount(shard.report))).toEqual([3, 3, 3]);
});

test('should keep a serial suite with its setup on one shard', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'setup.spec.ts': `
      import { test } from '@playwright/test';

      test('w=50 setup', async () => {});
    `,
    'app.spec.ts': `
      import { test } from '@playwright/test';

      test.describe.serial('serial group', () => {
        test('w=10 serial one', async () => {});
        test('w=10 serial two', async () => {});
        test('w=10 serial three', async () => {});
      });

      test('w=10 standalone one', async () => {});
      test('w=10 standalone two', async () => {});
    `,
    'unit.spec.ts': `
      import { test } from '@playwright/test';

      for (let i = 0; i < 100; ++i)
        test('w=1 unit-' + i, async () => {});
    `,
  }, 2, {}, {
    projects: [
      { name: 'setup', testMatch: 'setup.spec.ts' },
      { name: 'app', testMatch: 'app.spec.ts', dependencies: ['setup'] },
      { name: 'unit', testMatch: 'unit.spec.ts' },
    ],
  });

  expect(shards.map(shard => shard.totalWeight)).toEqual([100, 100]);
  // The serial suite, the standalone app tests and the setup all share a shard.
  expect(reportTestTitles(shards[0].report).sort()).toEqual([
    'w=10 serial one',
    'w=10 serial three',
    'w=10 serial two',
    'w=10 standalone one',
    'w=10 standalone two',
    'w=50 setup',
  ]);
});

test('should prefer shards that already run shared dependency projects', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'setup.spec.ts': `
      import { test } from '@playwright/test';

      test('w=50 setup', async () => {});
    `,
    'db.spec.ts': `
      import { test } from '@playwright/test';

      test('w=50 db', async () => {});
    `,
    'web.spec.ts': `
      import { test } from '@playwright/test';

      test('w=10 web', async () => {});
    `,
    'api.spec.ts': `
      import { test } from '@playwright/test';

      test('w=10 api', async () => {});
    `,
    'unit.spec.ts': `
      import { test } from '@playwright/test';

      for (let i = 0; i < 100; ++i)
        test('w=1 unit-' + i, async () => {});
    `,
  }, 2, {}, {
    projects: [
      { name: 'setup', testMatch: 'setup.spec.ts' },
      { name: 'db', testMatch: 'db.spec.ts' },
      { name: 'web', testMatch: 'web.spec.ts', dependencies: ['setup', 'db'] },
      { name: 'api', testMatch: 'api.spec.ts', dependencies: ['setup'] },
      { name: 'unit', testMatch: 'unit.spec.ts' },
    ],
  });

  // The api test joins the shard where the web test already pays for `setup`
  // (50 + 50 + 10 + 10 = 120) instead of starting a second copy of `setup`
  // elsewhere, which would have ended at 135 / 135.
  expect(shards.map(shard => shard.totalWeight)).toEqual([120, 100]);
  expect(shards.map(shard => reportTestCount(shard.report))).toEqual([4, 100]);
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
