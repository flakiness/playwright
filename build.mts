#!/usr/bin/env npx kubik

import esbuild from 'esbuild';
import fs from 'fs';
import { Task } from 'kubik';
import path from 'path';
import pkg from './package.json' assert { type: 'json' };

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
  ],
  outdir: outDir,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  // Bundle, but keep un-bundled all public dependencies.
  // This will bundle any references to devDependencies; in our case,
  // this is @flakiness/server.
  external: Object.keys({
    ...pkg.dependencies,
  }),
  bundle: true,
  minify: false,
});

if (!errors.length)
  await $`tsc --pretty -p .`;
