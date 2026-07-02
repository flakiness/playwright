#!/usr/bin/env npx kubik

import esbuild from 'esbuild';
import fs from 'fs';
import { Task } from 'kubik';
import path from 'path';

const { __dirname, $ } = Task.init(import.meta, {
  name: 'playwright',
  watch: [ './src' ],
});

const outDir = path.join(__dirname, 'lib');
const typesDir = path.join(__dirname, 'types');
const srcDir = path.join(__dirname, 'src');
await fs.promises.rm(outDir, { recursive: true, force: true });
await fs.promises.rm(typesDir, { recursive: true, force: true });

const { errors } = await esbuild.build({
  color: true,
  entryPoints: [
    path.join(srcDir, 'playwright-test.ts'),
    path.join(srcDir, 'flakiness-playwright-shard.ts'),
    path.join(srcDir, 'flakiness-playwright-timings.ts'),
  ],
  outdir: outDir,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  // Bundle all prod dependencies (zod in particular) so the published
  // package has zero runtime dependencies besides Playwright itself.
  bundle: true,
  external: ['@playwright/test'],
  banner: {
    // Bundled CJS dependencies require() node builtins at runtime.
    js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);`,
  },
  minify: false,
});

if (!errors.length)
  await $`tsc --pretty -p .`;
