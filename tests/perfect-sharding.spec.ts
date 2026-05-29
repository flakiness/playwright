import { expect, test } from '@playwright/test';
import { assertShardCoverage, generatePerfectShards, runShard } from './utils.js';

test('should generate perfect shards that cover all tests', async ({}, testInfo) => {
  const { allEntries, shardFiles, shards, targetDir } = await generatePerfectShards(testInfo, {
    'alpha.spec.ts': `
      import { expect, test } from '@playwright/test';

      test.describe('alpha suite', () => {
        test('first test d:1000', async () => {
          expect(1 + 1).toBe(2);
        });

        test('second test d:1', async () => {
          expect(2 + 2).toBe(4);
        });
      });
    `,

    'beta.spec.ts': `
      import { expect, test } from '@playwright/test';

      test('third test d:1', async () => {
        expect('beta').toBe('beta');
      });

      test('fourth test d:missing', async () => {
        expect(true).toBeTruthy();
      });

      test('fifth test', async () => {
        expect([1, 2, 3]).toHaveLength(3);
      });
    `,
  }, {
    total: 2,
  });

  expect(allEntries).toHaveLength(5);
  expect(shards).toHaveLength(2);
  expect(shards.every(shard => shard.length > 0)).toBeTruthy();
  assertShardCoverage(shards, allEntries);
  expect(shards[0]).toEqual([expect.stringContaining('first test d:1000')]);
  expect(shards[1]).toHaveLength(4);

  for (const shardFile of shardFiles) {
    const result = await runShard(targetDir, shardFile, ['--reporter=list']);
    expect(result.exitCode).toBe(0);
  }
});
