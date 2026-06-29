import type { FlakinessReport } from '@flakiness/flakiness-report';
import { ReportUtils } from '@flakiness/sdk';
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { fetchTimings, generateFlakinessReport, runPerfectShards } from './utils.js';

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
  }, 2, {}, { fullyParallel: true });

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
    fullyParallel: true,
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
  }, 2, {}, { fullyParallel: true });

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
  }, 2, {}, {
    fullyParallel: true,
  });

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
  }, 2, {}, { fullyParallel: true });

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
  }, 2, {}, { fullyParallel: true });

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

test('should keep distinct serial suites with the same title on separate shards', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test.describe.serial('checkout', () => {
        test('w=10 alpha-1', async () => {});
        test('w=10 alpha-2', async () => {});
      });

      test.describe.serial('checkout', () => {
        test('w=10 beta-1', async () => {});
        test('w=10 beta-2', async () => {});
      });
    `,
  }, 2, {}, { fullyParallel: true });

  // Two independent serial suites that happen to share a title ('checkout') are
  // separate indivisible units, so they should balance one-per-shard instead of
  // collapsing onto a single shard.
  expect(shards.map(shard => shard.totalWeight).sort((a, b) => a - b)).toEqual([20, 20]);
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
    fullyParallel: true,
    projects: [
      { name: 'setup', testMatch: 'setup.spec.ts' },
      { name: 'app', testMatch: 'app.spec.ts', dependencies: ['setup'] },
      { name: 'unit', testMatch: 'unit.spec.ts', },
    ],
  });

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
    fullyParallel: true,
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
    fullyParallel: true,
    projects: [
      { name: 'setup', testMatch: 'setup.spec.ts', teardown: 'teardown' },
      { name: 'teardown', testMatch: 'teardown.spec.ts' },
      { name: 'app', testMatch: 'app.spec.ts', dependencies: ['setup'] },
      { name: 'unit', testMatch: 'unit.spec.ts' },
    ],
  });

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
    fullyParallel: true,
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
    fullyParallel: true,
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

test('should not split one atomic dependent group across extra shards', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'setup.spec.ts': `
      import { test } from '@playwright/test';

      test('w=10 setup', async () => {});
    `,
    'app.spec.ts': `
      import { test } from '@playwright/test';

      test.describe.serial('atomic app group', () => {
        for (let i = 0; i < 10; ++i)
          test('w=10 app-' + i, async () => {});
      });
    `,
    'unit.spec.ts': `
      import { test } from '@playwright/test';

      for (let i = 0; i < 200; ++i)
        test('w=1 unit-' + i, async () => {});
    `,
  }, 3, {}, {
    fullyParallel: true,
    projects: [
      { name: 'setup', testMatch: 'setup.spec.ts' },
      { name: 'app', testMatch: 'app.spec.ts', dependencies: ['setup'] },
      { name: 'unit', testMatch: 'unit.spec.ts' },
    ],
  });

  // The serial suite is one shard group, so it can occupy only one shard:
  // setup + 10 app tests = 110, with unit tests filling the other two shards.
  expect(shards.map(shard => shard.totalWeight).sort((a, b) => a - b)).toEqual([100, 100, 110]);
  expect(shards.map(shard => reportTestCount(shard.report)).sort((a, b) => a - b)).toEqual([11, 100, 100]);
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
    fullyParallel: true,
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
    fullyParallel: true,
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

test('should account only for missing setup when deciding family span', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'setup-a.spec.ts': `
      import { test } from '@playwright/test';

      test('w=7 setup A', async () => {});
    `,
    'setup-b.spec.ts': `
      import { test } from '@playwright/test';

      test('w=4 setup B', async () => {});
    `,
    'setup-c.spec.ts': `
      import { test } from '@playwright/test';

      test('w=1 setup C', async () => {});
    `,
    'ab.spec.ts': `
      import { test } from '@playwright/test';

      test('w=40 ab high', async () => {});
      test('w=32 ab low', async () => {});
    `,
    'ac.spec.ts': `
      import { test } from '@playwright/test';

      test('w=22 ac high', async () => {});
      test('w=12 ac low', async () => {});
    `,
    'a.spec.ts': `
      import { test } from '@playwright/test';

      test('w=32 a only', async () => {});
    `,
  }, 2, {}, {
    fullyParallel: true,
    projects: [
      { name: 'setup-a', testMatch: 'setup-a.spec.ts' },
      { name: 'setup-b', testMatch: 'setup-b.spec.ts' },
      { name: 'setup-c', testMatch: 'setup-c.spec.ts' },
      { name: 'ab', testMatch: 'ab.spec.ts', dependencies: ['setup-a', 'setup-b'] },
      { name: 'ac', testMatch: 'ac.spec.ts', dependencies: ['setup-a', 'setup-c'] },
      { name: 'a', testMatch: 'a.spec.ts', dependencies: ['setup-a'] },
    ],
  });

  // The `ac` family should stay on the shard that already runs setup A.
  expect(shards.map(shard => shard.totalWeight)).toEqual([83, 78]);
  expect(shards.map(shard => reportTestTitles(shard.report).sort())).toEqual([
    [
      'w=32 a only',
      'w=4 setup B',
      'w=40 ab high',
      'w=7 setup A',
    ],
    [
      'w=1 setup C',
      'w=12 ac low',
      'w=22 ac high',
      'w=32 ab low',
      'w=4 setup B',
      'w=7 setup A',
    ],
  ]);
});

test('should use the widest family span when span costs are tied', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'setup-a.spec.ts': `
      import { test } from '@playwright/test';

      test('w=13 setup A', async () => {});
    `,
    'app.spec.ts': `
      import { test } from '@playwright/test';

      test('w=37 app high', async () => {});
      test('w=18 app mid', async () => {});
      test('w=16 app low', async () => {});
    `,
    'unit.spec.ts': `
      import { test } from '@playwright/test';

      test('w=34 unit high', async () => {});
      test('w=29 unit mid', async () => {});
      test('w=18 unit low', async () => {});
      test('w=15 unit small', async () => {});
    `,
  }, 3, {}, {
    fullyParallel: true,
    projects: [
      { name: 'setup-a', testMatch: 'setup-a.spec.ts' },
      { name: 'app', testMatch: 'app.spec.ts', dependencies: ['setup-a'] },
      { name: 'unit', testMatch: 'unit.spec.ts' },
    ],
  });

  // Once app work has used two shards, the independent unit family has equal
  // estimated costs for spanning 2 or 3 shards. Prefer the wider span so the
  // zero-setup filler can balance all shards.
  expect(shards.map(shard => shard.totalWeight).sort((a, b) => a - b)).toEqual([63, 65, 65]);
  expect(shards.map(shard => reportTestTitles(shard.report).some(title => title.includes('unit')))).toEqual([true, true, true]);
});

test('should not split a non-fully-parallel spec file across shards', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('w=10 alpha', async () => {});
      test('w=10 beta', async () => {});
      test('w=10 gamma', async () => {});
      test('w=10 delta', async () => {});
    `,
  }, 2);

  // Without fullyParallel, Playwright runs a file's tests in order on one worker,
  // so the whole file is one indivisible shard group and lands entirely on one shard.
  expect(shards.map(shard => shard.totalWeight).sort((a, b) => a - b)).toEqual([0, 40]);
  expect(shards.map(shard => reportTestCount(shard.report)).sort((a, b) => a - b)).toEqual([0, 4]);
});

test('should distribute whole spec files across shards by default', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'alpha.spec.ts': `
      import { test } from '@playwright/test';

      test('w=10 alpha-1', async () => {});
      test('w=10 alpha-2', async () => {});
      test('w=10 alpha-3', async () => {});
    `,
    'beta.spec.ts': `
      import { test } from '@playwright/test';

      test('w=10 beta-1', async () => {});
      test('w=10 beta-2', async () => {});
      test('w=10 beta-3', async () => {});
    `,
  }, 2);

  // Each file is one indivisible group, so the two files split cleanly across shards.
  expect(shards.map(shard => shard.totalWeight).sort((a, b) => a - b)).toEqual([30, 30]);
  // A single file is never split: no shard contains tests from both files.
  for (const shard of shards) {
    const titles = reportTestTitles(shard.report);
    const hasAlpha = titles.some(title => title.includes('alpha'));
    const hasBeta = titles.some(title => title.includes('beta'));
    expect(hasAlpha && hasBeta).toBe(false);
    expect(titles.length).toBe(3);
  }
});

test('should shard a parallel describe per-test even without fullyParallel', async ({}, testInfo) => {
  const shards = await runPerfectShards(testInfo, {
    'plain.spec.ts': `
      import { test } from '@playwright/test';

      test('w=10 plain', async () => {});
    `,
    'par.spec.ts': `
      import { test } from '@playwright/test';

      test.describe.parallel('parallel group', () => {
        test('w=10 par-1', async () => {});
        test('w=10 par-2', async () => {});
        test('w=10 par-3', async () => {});
      });
    `,
  }, 2);

  // A `test.describe.parallel` block is shardable per-test even though the project
  // is not fullyParallel, so its three tests balance against the plain file to 20 / 20.
  // (Were the block sequential, it would be one atomic group and yield 30 / 10.)
  expect(shards.map(shard => shard.totalWeight).sort((a, b) => a - b)).toEqual([20, 20]);
});

test('should balance shards using a --timings file instead of the Durations API', async ({}, testInfo) => {
  const files = {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('alpha', async () => {});
      test('beta', async () => {});
      test('gamma', async () => {});
      test('delta', async () => {});
    `,
  };

  // A previous run's report is a valid timings file. Build one (reusing the real
  // test ids) and weight 'alpha' so heavily it must occupy a shard by itself — a
  // split the Durations API path can never produce here, since these titles carry
  // no weights and the fake server would report no durations at all.
  const { report } = await generateFlakinessReport(testInfo, files, {}, { fullyParallel: true });
  const timings = withDurations(report, { alpha: 100, beta: 1, gamma: 1, delta: 1 });
  const timingsFile = testInfo.outputPath('timings.json');
  fs.writeFileSync(timingsFile, JSON.stringify(timings));

  const shards = await runPerfectShards(testInfo, files, 2, {}, { fullyParallel: true }, undefined, [`--timings=${timingsFile}`]);

  expect(shards.map(shard => reportTestCount(shard.report)).sort((a, b) => a - b)).toEqual([1, 3]);
  const soloShard = shards.find(shard => reportTestCount(shard.report) === 1)!;
  expect(reportTestTitles(soloShard.report)).toEqual(['alpha']);
});

test('should fetch timings into a local file', async ({}, testInfo) => {
  const { timings, timingsFile } = await fetchTimings(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('w=100 alpha', async () => {});
      test('w=1 beta', async () => {});
    `,
  }, {}, { fullyParallel: true });

  expect(fs.existsSync(timingsFile)).toBe(true);
  expect(durationsByTitle(timings)).toEqual({
    'w=100 alpha': [100],
    'w=1 beta': [1],
  });
});

test('should reject a missing --timings file', async ({}, testInfo) => {
  await expect(runPerfectShards(testInfo, {
    'example.spec.ts': `
      import { test } from '@playwright/test';

      test('w=10 alpha', async () => {});
    `,
  }, 2, {}, {}, undefined, ['--timings=./does-not-exist.json'])).rejects.toThrow(/--timings file not found/);
});

// Replaces each test's attempts with a single attempt per environment whose
// duration is looked up by test title. Produces a Flakiness report shaped exactly
// like one a previous run would write, suitable as a `--timings` file.
function withDurations(report: FlakinessReport.Report, durationByTitle: Record<string, number>): FlakinessReport.Report {
  const result = JSON.parse(JSON.stringify(report)) as FlakinessReport.Report;
  ReportUtils.visitTests(result, test => {
    const duration = durationByTitle[test.title];
    if (duration === undefined)
      return;
    test.attempts = result.environments.map((_env, environmentIdx) => ({
      environmentIdx,
      status: 'passed' as FlakinessReport.TestStatus,
      startTimestamp: 0 as FlakinessReport.UnixTimestampMS,
      duration: duration as FlakinessReport.DurationMS,
    }));
  });
  return result;
}

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

function durationsByTitle(report: FlakinessReport.Report): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  ReportUtils.visitTests(report, test => {
    result[test.title] = test.attempts.map(attempt => attempt.duration ?? 0);
  });
  return result;
}
