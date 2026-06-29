#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { formatDuration, isFlag, parseArgs, runPlaywright, TIMINGS_OUTPUT_ENV } from './utils.js';

const usage = `Usage:
  flakiness-playwright-timings fetch --output=<file> [playwright test args...]

Fetches historical Playwright test timings from Flakiness.io.

Commands:
  fetch              Fetch timings for the selected Playwright tests.

Fetch options:
  -o, --output=<file>  Write fetched timings to this JSON file (required).

All other arguments are passed through to "playwright test --list".`;

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '-h' || args[0] === '--help') {
    console.log(usage);
    return 0;
  }
  const command = args.shift();
  if (!command)
    throw new Error(`missing command\n\n${usage}`);
  if (command !== 'fetch')
    throw new Error(`unknown command "${command}"\n\n${usage}`);

  const { values, flags, passthrough } = parseArgs(args, {
    values: [
      { name: 'output', aliases: ['-o', '--output'] },
    ],
    bools: [
      { name: 'help', aliases: ['-h', '--help'] },
    ],
  });
  if (flags.has('help')) {
    console.log(usage);
    return 0;
  }
  if (values.output === undefined)
    throw new Error(`missing required --output argument\n\n${usage}`);
  assertFetchPassthroughArgs(passthrough);

  const outputFile = path.resolve(process.cwd(), values.output);
  const startTime = Date.now();
  console.error(`Fetching Playwright timings...`);
  const exitCode = runPlaywright(['--list', ...passthrough], {
    ...process.env,
    [TIMINGS_OUTPUT_ENV]: outputFile,
  }, false);
  console.error(`Done ${formatDuration(Date.now() - startTime)}`);
  if (exitCode !== 0) {
    console.error(`failed to fetch Playwright timings: playwright exited with code ${exitCode}`);
    return exitCode;
  }
  if (!fs.existsSync(outputFile))
    throw new Error('failed to fetch Playwright timings: timings file was not created. Is @flakiness/playwright configured as a reporter?');
  return 0;
}

function assertFetchPassthroughArgs(args: string[]) {
  for (const arg of args) {
    if (isFlag(arg, '--list'))
      throw new Error(`"${arg}" is managed by flakiness-playwright-timings fetch and cannot be passed explicitly`);
    if (isFlag(arg, '--test-list'))
      throw new Error(`"${arg}" would fetch timings for only a subset of tests and cannot be passed explicitly`);
    if (isFlag(arg, '--shard'))
      throw new Error(`"${arg}" would fetch timings for only one Playwright shard and cannot be passed explicitly`);
    if (isFlag(arg, '--reporter'))
      throw new Error(`"${arg}" replaces the configured reporters and would disable @flakiness/playwright during timings fetch`);
  }
}

main().then(code => {
  process.exitCode = code;
}).catch(e => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
