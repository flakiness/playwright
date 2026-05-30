#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

type Shard = {
  current: number;
  total: number;
};

type ParsedArgs = {
  shard?: Shard;
  passthrough: string[];
  help: boolean;
};

const usage = `Usage:
  flakiness-playwright-shard --shard=1/2 [playwright test args...]

Runs Playwright Test with Flakiness perfect sharding.
All arguments except --shard are passed through to "playwright test".`;

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(usage);
    return 0;
  }
  if (!parsed.shard)
    throw new Error(`missing required --shard argument\n\n${usage}`);
  assertWrapperOwnedArgsAbsent(parsed.passthrough);

  const playwrightCLI = resolvePlaywrightCLI();
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'flakiness-playwright-shard-'));
  const shardFile = path.join(tmpDir, `shard-${parsed.shard.current}-of-${parsed.shard.total}.txt`);

  try {
    const startTime = Date.now();
    console.error(`Generating balanced shard ${parsed.shard.current}/${parsed.shard.total}...`);
    const listExitCode = runPlaywright(playwrightCLI, ['--list', ...parsed.passthrough], {
      ...process.env,
      FLAKINESS_SHARD: `${parsed.shard.current}/${parsed.shard.total}`,
      FLAKINESS_SHARD_FILE: shardFile,
    }, false);
    console.error(`Done ${formatDuration(Date.now() - startTime)}`);
    if (listExitCode !== 0) {
      console.error(`failed to generate perfect shard: playwright exited with code ${listExitCode}`);
      return listExitCode;
    }
    if (!fs.existsSync(shardFile))
      throw new Error('failed to generate perfect shard: shard file was not created. Is @flakiness/playwright configured as a reporter?');

    const runArgs = [`--test-list=${shardFile}`, ...parsed.passthrough];
    if (!hasArg(parsed.passthrough, '--pass-with-no-tests'))
      runArgs.unshift('--pass-with-no-tests');

    return runPlaywright(playwrightCLI, runArgs, process.env, true);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { passthrough: [], help: false };
  for (let i = 0; i < args.length; ++i) {
    const arg = args[i];
    if (arg === '--') {
      result.passthrough.push(...args.slice(i + 1));
      break;
    }
    if (arg === '-h' || arg === '--help') {
      result.help = true;
      continue;
    }
    if (arg === '--shard') {
      if (result.shard)
        throw new Error('duplicate --shard argument');
      const value = args[++i];
      if (!value || value.startsWith('-'))
        throw new Error('missing value for --shard');
      result.shard = parseShard(value);
      continue;
    }
    if (arg.startsWith('--shard=')) {
      if (result.shard)
        throw new Error('duplicate --shard argument');
      result.shard = parseShard(arg.substring('--shard='.length));
      continue;
    }
    result.passthrough.push(arg);
  }
  return result;
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
  for (let i = 0; i < args.length; ++i) {
    const arg = args[i];
    if (arg === '--list' || arg.startsWith('--test-list=') || arg === '--test-list')
      throw new Error(`"${arg}" is managed by flakiness-playwright-shard and cannot be passed explicitly`);
    if (arg === '--shard' || arg.startsWith('--shard='))
      throw new Error(`"${arg}" is managed by flakiness-playwright-shard and cannot be passed as a Playwright argument`);
    if (arg === '--reporter' || arg.startsWith('--reporter='))
      throw new Error(`"${arg}" replaces the configured reporters and would disable @flakiness/playwright during shard generation`);
  }
}

function hasArg(args: string[], name: string): boolean {
  return args.some(arg => arg === name || arg.startsWith(`${name}=`));
}

function formatDuration(durationMS: number): string {
  return `${(durationMS / 1000).toFixed(1)} seconds`;
}

function resolvePlaywrightCLI(): string {
  const cwdRequire = createRequire(path.join(process.cwd(), 'package.json'));
  try {
    return cwdRequire.resolve('@playwright/test/cli');
  } catch (e) {
    const ownRequire = createRequire(import.meta.url);
    try {
      return ownRequire.resolve('@playwright/test/cli');
    } catch {
      throw new Error('failed to resolve @playwright/test. Install @playwright/test in this project before using flakiness-playwright-shard');
    }
  }
}

function runPlaywright(cliPath: string, args: string[], env: NodeJS.ProcessEnv, inheritStdio: boolean): number {
  const result = spawnSync(process.execPath, [cliPath, 'test', ...args], {
    cwd: process.cwd(),
    env,
    stdio: inheritStdio ? 'inherit' : ['ignore', 'ignore', 'inherit'],
  });
  if (typeof result.status === 'number')
    return result.status;
  if (result.signal)
    return os.constants.signals[result.signal] ? 128 + os.constants.signals[result.signal] : 1;
  return 1;
}

main().then(code => {
  process.exitCode = code;
}).catch(e => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
