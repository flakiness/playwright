#!/usr/bin/env node

import fs from 'fs';
import path from 'node:path';
import { distillTimings } from './timings.js';
import { isFlag, parseArgs, readReportFile, runPlaywright } from './utils.js';

const usage = `Usage:
  flakiness-playwright-timings build <report.json...> [-o <output>]
  flakiness-playwright-timings fetch [playwright test args...] [-o <output>] [--token <token>] [--endpoint <url>]

Produces a lean timings report (for "flakiness-playwright-shard --timings=<output>")
from local Flakiness reports, or by fetching historical durations from Flakiness.io.

Subcommands:
  build   Combine and minimize durations from one or more local Flakiness reports.
  fetch   Run "playwright test --list" to discover the current test set, fetch its
          historical durations from the Flakiness.io Durations API, and distill them
          into a timings report. Extra arguments are passed through to "playwright test".

Options:
  -o, --output <file>   Write the timings report to <file> (default: timings.json).
  --token <token>       Flakiness.io access token (fetch only; defaults to
                        FLAKINESS_ACCESS_TOKEN, then GitHub OIDC, then anonymous).
  --endpoint <url>      Flakiness.io endpoint (fetch only; defaults to
                        FLAKINESS_ENDPOINT or https://flakiness.io).
  -h, --help            Show this help.`;

async function runBuild(args: string[]): Promise<number> {
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
  if (!passthrough.length)
    throw new Error(`"build" requires at least one report file\n\n${usage}`);

  const reports = await Promise.all(passthrough.map(async reportPath => readReportFile(reportPath)));
  const timings = distillTimings(reports);
  await fs.promises.writeFile(values.output ?? `timings.json`, JSON.stringify(timings, null, 2));
  return 0;
}

async function runFetch(args: string[]): Promise<number> {
  const { values, flags, passthrough } = parseArgs(args, {
    values: [
      { name: 'output', aliases: ['-o', '--output'] },
      { name: 'token', aliases: ['--token'] },
      { name: 'endpoint', aliases: ['--endpoint'] },
    ],
    bools: [
      { name: 'help', aliases: ['-h', '--help'] },
    ],
  });
  if (flags.has('help')) {
    console.log(usage);
    return 0;
  }
  for (const arg of passthrough) {
    if (isFlag(arg, '--list') || isFlag(arg, '--reporter'))
      throw new Error(`"${arg}" is managed by flakiness-playwright-timings and cannot be passed explicitly`);
  }

  // The reporter, in --list mode, fetches historical durations for the listed
  // tests, distills them, and writes the timings report to this path.
  const outputFile = path.resolve(process.cwd(), values.output ?? 'timings.json');
  const env: NodeJS.ProcessEnv = { ...process.env, FLAKINESS_TIMINGS_OUTPUT: outputFile };
  if (values.token)
    env.FLAKINESS_ACCESS_TOKEN = values.token;
  if (values.endpoint)
    env.FLAKINESS_ENDPOINT = values.endpoint;

  const listExitCode = runPlaywright(['--list', ...passthrough], env, false);
  if (listExitCode !== 0) {
    console.error(`failed to fetch timings: playwright exited with code ${listExitCode}`);
    return listExitCode;
  }
  if (!fs.existsSync(outputFile))
    throw new Error('failed to fetch timings: no timings report was written. Is @flakiness/playwright configured as a reporter?');
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];
  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    console.log(usage);
    // No subcommand is an error; explicit --help is not.
    return subcommand ? 0 : 1;
  }
  switch (subcommand) {
    case 'build':
      return await runBuild(argv.slice(1));
    case 'fetch':
      return await runFetch(argv.slice(1));
    default:
      throw new Error(`unknown subcommand "${subcommand}"\n\n${usage}`);
  }
}

main().then(code => {
  process.exitCode = code;
}).catch(e => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
