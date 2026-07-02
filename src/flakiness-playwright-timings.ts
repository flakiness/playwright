#!/usr/bin/env node

import fs from 'fs';
import { distillTimings } from './timings.js';
import { parseArgs, readReportFile } from './utils.js';

const usage = `Usage:
  flakiness-playwright-timings build [-o <output>] <report.json...> 

Distills one or more Flakiness reports into a lean timings report, suitable for
"flakiness-playwright-shard --timings=<output>".

Subcommands:
  build   Combine and minimize durations from one or more Flakiness reports.

Options:
  -o, --output <file>   Write the timings report to <file> (default: timings.json).
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
