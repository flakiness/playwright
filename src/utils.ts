// Shared plumbing for the `flakiness-playwright-shard` and
// `flakiness-playwright-timings` wrapper binaries. Both spawn `playwright test`
// after parsing a couple of their own flags off the front, so the argument
// parsing, Playwright resolution and process handling live here once.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

export const TIMINGS_OUTPUT_ENV = 'FLAKINESS_TIMINGS_OUTPUT_FILE';

// Whether `arg` is the flag `name`, either bare (`--foo`) or with an attached
// value (`--foo=bar`).
export function isFlag(arg: string, name: string): boolean {
  return arg === name || arg.startsWith(`${name}=`);
}

// A flag the parser should pull out of the argument list. `name` is the key it
// reports under; `aliases` are the accepted spellings (e.g. `['-o', '--output']`).
export type Flag = { name: string, aliases: string[] };

// What the wrapper recognizes as its own. Everything not listed here is treated
// as a passthrough arg for `playwright test`.
export type ArgsSpec = {
  values?: Flag[];   // take a value: `--flag value` or `--flag=value`
  bools?: Flag[];    // present-or-not: `--flag`
};

export type ParsedArgs = {
  values: Record<string, string>;   // value flag name -> value
  flags: Set<string>;               // names of the bool flags that were present
  passthrough: string[];            // everything else, verbatim, in order
};

function display(flag: Flag): string {
  return flag.aliases.find(alias => alias.startsWith('--')) ?? flag.aliases[0];
}

// Parses the wrapper's own flags off `args`. Stops at `--`, recognizes the
// declared value and bool flags, and leaves everything else in `passthrough` so
// it reaches `playwright test` byte-for-byte.
export function parseArgs(args: string[], spec: ArgsSpec): ParsedArgs {
  const valueFlags = spec.values ?? [];
  const boolFlags = spec.bools ?? [];
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const passthrough: string[] = [];
  for (let i = 0; i < args.length; ++i) {
    const arg = args[i];
    if (arg === '--') {
      passthrough.push(...args.slice(i + 1));
      break;
    }
    const boolFlag = boolFlags.find(f => f.aliases.includes(arg));
    if (boolFlag) {
      flags.add(boolFlag.name);
      continue;
    }
    const valueFlag = valueFlags.find(f => f.aliases.some(alias => isFlag(arg, alias)));
    if (!valueFlag) {
      passthrough.push(arg);
      continue;
    }
    if (values[valueFlag.name] !== undefined)
      throw new Error(`duplicate ${display(valueFlag)} argument`);
    const attached = valueFlag.aliases.map(alias => `${alias}=`).find(prefix => arg.startsWith(prefix));
    let value: string | undefined;
    if (attached !== undefined)
      value = arg.substring(attached.length);
    else
      value = args[++i];
    // In the `--flag=value` form the value is unambiguous; in the spaced form a
    // leading `-` means the user forgot the value and we ran into the next flag.
    if (!value || (attached === undefined && value.startsWith('-')))
      throw new Error(`missing value for ${display(valueFlag)}`);
    values[valueFlag.name] = value;
  }
  return { values, flags, passthrough };
}

export function formatDuration(durationMS: number): string {
  return `${(durationMS / 1000).toFixed(1)} seconds`;
}

let playwrightCLI: string | undefined;

// Resolves Playwright's CLI from the user's project first, falling back to our
// own dependencies. Memoized: resolution happens once per process. On failure
// the message names the running binary, derived from argv[1].
function resolvePlaywrightCLI(): string {
  if (playwrightCLI !== undefined)
    return playwrightCLI;
  const cwdRequire = createRequire(path.join(process.cwd(), 'package.json'));
  try {
    return playwrightCLI = cwdRequire.resolve('@playwright/test/cli');
  } catch {
    const ownRequire = createRequire(import.meta.url);
    try {
      return playwrightCLI = ownRequire.resolve('@playwright/test/cli');
    } catch {
      const binName = path.basename(process.argv[1] ?? 'flakiness-playwright', '.js');
      throw new Error(`failed to resolve @playwright/test. Install @playwright/test in this project before using ${binName}`);
    }
  }
}

// Runs `playwright test <args>` and maps the result to an exit code. When
// `inheritStdio` is false, stdout is silenced (used for the `--list` pass).
export function runPlaywright(args: string[], env: NodeJS.ProcessEnv, inheritStdio: boolean): number {
  const result = spawnSync(process.execPath, [resolvePlaywrightCLI(), 'test', ...args], {
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
