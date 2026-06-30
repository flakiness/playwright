#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SHARD_HINT_ENV } from './sharding.js';
import { formatDuration, isFlag, parseArgs, runPlaywright } from './utils.js';

type Shard = {
  current: number;
  total: number;
};

const usage = `Usage:
  flakiness-playwright-shard --shard=1/2 [playwright test args...]

Runs Playwright Test with Flakiness perfect sharding.

Options:
  --shard=N/M        Generate and run the balanced shard N of M (required).

All other arguments are passed through to "playwright test".`;

async function main() {
  const { values, flags, passthrough } = parseArgs(process.argv.slice(2), {
    values: [
      { name: 'shard', aliases: ['--shard'] },
    ],
    bools: [
      { name: 'help', aliases: ['-h', '--help'] },
    ],
  });
  if (flags.has('help')) {
    console.log(usage);
    return 0;
  }
  if (values.shard === undefined)
    throw new Error(`missing required --shard argument\n\n${usage}`);
  assertWrapperOwnedArgsAbsent(passthrough);
  const shard = parseShard(values.shard);
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'flakiness-playwright-shard-'));
  const shardFile = path.join(tmpDir, `shard-${shard.current}-of-${shard.total}.txt`);

  try {
    const startTime = Date.now();
    console.error(`Generating balanced shard ${shard.current}/${shard.total}...`);
    const listExitCode = runPlaywright(['--list', ...passthrough], {
      ...process.env,
      FLAKINESS_SHARD: `${shard.current}/${shard.total}`,
      FLAKINESS_SHARD_FILE: shardFile,
    }, false);
    console.error(`Done ${formatDuration(Date.now() - startTime)}`);
    if (listExitCode !== 0) {
      console.error(`failed to generate perfect shard: playwright exited with code ${listExitCode}`);
      return listExitCode;
    }
    if (!fs.existsSync(shardFile))
      throw new Error('failed to generate perfect shard: shard file was not created. Is @flakiness/playwright configured as a reporter?');

    const runArgs = [`--test-list=${shardFile}`, ...passthrough];
    if (!passthrough.some(arg => isFlag(arg, '--pass-with-no-tests')))
      runArgs.unshift('--pass-with-no-tests');

    return runPlaywright(runArgs, {
      ...process.env,
      // Hint the reporter that this run is shard N/M (the run uses --test-list,
      // not --shard, so Playwright's native config.shard is null).
      [SHARD_HINT_ENV]: `${shard.current}/${shard.total}`,
    }, true);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

function parseShard(value: string): Shard {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match)
    throw new Error(`invalid --shard value "${value}", expected N/M`);
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (!current || !total || current > total)
    throw new Error(`invalid --shard value "${value}", expected 1 <= N <= M`);
  return { current, total };
}

function assertWrapperOwnedArgsAbsent(args: string[]) {
  for (const arg of args) {
    if (isFlag(arg, '--list') || isFlag(arg, '--test-list'))
      throw new Error(`"${arg}" is managed by flakiness-playwright-shard and cannot be passed explicitly`);
    if (isFlag(arg, '--shard'))
      throw new Error(`"${arg}" is managed by flakiness-playwright-shard and cannot be passed as a Playwright argument`);
    if (isFlag(arg, '--reporter'))
      throw new Error(`"${arg}" replaces the configured reporters and would disable @flakiness/playwright during shard generation`);
  }
}

main().then(code => {
  process.exitCode = code;
}).catch(e => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
