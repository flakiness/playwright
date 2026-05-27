import { FlakinessReport as FK } from '@flakiness/flakiness-report';
import { GithubOIDC, ReportUtils } from '@flakiness/sdk';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress } from 'node:zlib';

const brotliCompressAsync = promisify(brotliCompress);

export type ReporterMode = 'list' | 'test' | 'merge';

type ShardSlot = { current: number; total: number };

type ShardRequest = { slot: ShardSlot; outputFile: string };

function parseShardEnv(): ShardRequest | undefined {
  const slotValue = process.env.FK_EXP_SHARD;
  const fileValue = process.env.FK_EXP_SHARD_FILE;
  if (!slotValue || !fileValue)
    return undefined;
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(slotValue);
  if (!match)
    return undefined;
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (!total || current < 1 || current > total)
    return undefined;
  return { slot: { current, total }, outputFile: fileValue };
}

export function isShardRun(mode: ReporterMode | undefined): ShardRequest | undefined {
  if (mode !== 'list') return undefined;
  return parseShardEnv();
}

type ShardLogger = {
  log(msg: string): void;
  warn(msg: string): void;
  err(msg: string): void;
};

/**
 * A test enumerated by the local Playwright runner, ready to be matched to historical
 * durations and bin-packed into a shard. `fileGitRelative` matches what the Flakiness
 * backend stores; `fileRootDirRelative` is what gets emitted into Playwright's
 * `--test-list` file.
 */
export type PlannedTest = {
  projectName: string;
  fileRootDirRelative: string;
  fileGitRelative: string;
  titlePath: string[];
};

type WriteShardOptions = {
  flakinessEndpoint?: string;
  flakinessAccessToken?: string;
  logger: ShardLogger;
  outputFile: string;
};

export async function writeShardTestList(
  currentReport: FK.Report,
  tests: PlannedTest[],
  slot: ShardSlot,
  options: WriteShardOptions,
): Promise<void> {
  const { logger } = options;
  const historical = await fetchHistoricalDurations(currentReport, options);
  const durationsByKey = historical ? buildDurationMap(historical) : new Map<string, number[]>();

  let knownCount = 0;
  let knownSum = 0;
  for (const samples of durationsByKey.values()) {
    for (const ms of samples) {
      knownSum += ms;
      ++knownCount;
    }
  }
  const fallbackMs = knownCount ? knownSum / knownCount : 1000;

  const annotated: AnnotatedTest[] = tests.map(test => {
    const key = makeKey(test.projectName, test.fileGitRelative, test.titlePath);
    const samples = durationsByKey.get(key);
    const duration = samples?.length ? mean(samples) : fallbackMs;
    return { test, duration, known: !!samples?.length };
  });

  const shards = lptBinPack(annotated, slot.total);
  const myShard = shards[slot.current - 1];
  const myLoadMs = myShard.reduce((s, x) => s + x.duration, 0);
  const knownInShard = myShard.filter(x => x.known).length;

  const outputFile = path.resolve(options.outputFile);
  await fs.promises.mkdir(path.dirname(outputFile), { recursive: true });
  const lines = myShard.map(x => formatTestListLine(x.test));
  await fs.promises.writeFile(outputFile, lines.join('\n') + (lines.length ? '\n' : ''));

  logger.log(
    `perfect-shards: wrote ${myShard.length} tests to ${outputFile} ` +
    `(slot ${slot.current}/${slot.total}, est ${Math.round(myLoadMs / 1000)}s, ` +
    `${knownInShard}/${myShard.length} with historical data, fallback=${Math.round(fallbackMs)}ms)`,
  );
}

function formatTestListLine(test: PlannedTest): string {
  return `[${test.projectName}] > ${test.fileRootDirRelative}${test.titlePath.map(t => ` > ${t}`).join('')}`;
}

function makeKey(envName: string, file: string, titles: string[]): string {
  return [envName, file, ...titles].join('\0');
}

function buildDurationMap(report: FK.Report): Map<string, number[]> {
  const map = new Map<string, number[]>();
  const envNames = (report.environments ?? []).map(e => e.name);
  ReportUtils.visitTests(report, (test, parentSuites) => {
    const fileSuite = parentSuites.find(s => s.type === 'file');
    const file = fileSuite?.location?.file ?? test.location?.file;
    if (!file)
      return;
    const titles: string[] = [];
    for (const s of parentSuites) {
      if (s.type === 'file')
        continue;
      if (!s.title)
        continue;
      titles.push(s.title);
    }
    titles.push(test.title);
    for (const attempt of test.attempts ?? []) {
      if (typeof attempt.duration !== 'number' || !Number.isFinite(attempt.duration) || attempt.duration < 0)
        continue;
      const envName = envNames[attempt.environmentIdx ?? 0];
      if (!envName)
        continue;
      const key = makeKey(envName, file, titles);
      let arr = map.get(key);
      if (!arr) {
        arr = [];
        map.set(key, arr);
      }
      arr.push(attempt.duration);
    }
  });
  return map;
}

function mean(values: number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

type AnnotatedTest = { test: PlannedTest; duration: number; known: boolean };

function lptBinPack(items: AnnotatedTest[], shardCount: number): AnnotatedTest[][] {
  const sorted = items.slice().sort((a, b) => b.duration - a.duration);
  const shards: AnnotatedTest[][] = Array.from({ length: shardCount }, () => []);
  const loads = new Array<number>(shardCount).fill(0);
  for (const item of sorted) {
    let minIdx = 0;
    for (let i = 1; i < shardCount; ++i) {
      if (loads[i] < loads[minIdx])
        minIdx = i;
    }
    shards[minIdx].push(item);
    loads[minIdx] += item.duration;
  }
  return shards;
}

async function fetchHistoricalDurations(
  report: FK.Report,
  options: WriteShardOptions,
): Promise<FK.Report | undefined> {
  const { logger } = options;
  const endpoint = (options.flakinessEndpoint ?? process.env.FLAKINESS_ENDPOINT ?? 'https://flakiness.io').replace(/\/+$/, '');

  const token = await resolveAccessToken(options.flakinessAccessToken, report.flakinessProject, logger);
  if (!token) {
    logger.warn(`perfect-shards: no Flakiness access token available (set FLAKINESS_ACCESS_TOKEN, pass token, or run in GitHub Actions with id-token: write)`);
    return;
  }

  const shardGroupKey = computeShardGroupKey({
    runnerName: report.testRunner?.name ?? 'unknown',
    runnerVersion: report.testRunner?.version,
    envNames: report.environments.map(e => e.name),
  });

  const [orgSlug, projectSlug] = report.flakinessProject ? report.flakinessProject.split('/') : [];

  const createRes = await postJSON<{ testDurationsToken: string; uploadUrl: string }>(
    `${endpoint}/api/testDurations/create`,
    token,
    { orgSlug, projectSlug, commitId: report.commitId, shardGroupKey },
  );
  if (!createRes.ok) {
    logger.err(`perfect-shards: testDurations.create failed: ${createRes.error}`);
    return;
  }

  const compressed = await brotliCompressAsync(Buffer.from(JSON.stringify(report)));
  const uploadResponse = await fetch(createRes.value.uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Content-Encoding': 'br',
      'Content-Length': String(compressed.byteLength),
    },
    body: new Uint8Array(compressed),
  });
  if (!uploadResponse.ok) {
    logger.err(`perfect-shards: input upload failed (${uploadResponse.status} ${uploadResponse.statusText})`);
    return;
  }

  const submitRes = await postJSON<{ downloadUrl: string }>(
    `${endpoint}/api/testDurations/submit`,
    createRes.value.testDurationsToken,
    undefined,
  );
  if (!submitRes.ok) {
    logger.err(`perfect-shards: testDurations.submit failed: ${submitRes.error}`);
    return;
  }

  const deadlineMs = Date.now() + 1000 * 60;
  while (Date.now() < deadlineMs) {
    const downloadResponse = await fetch(submitRes.value.downloadUrl);
    if (!downloadResponse.ok) {
      await new Promise(x => setTimeout(x, 1000));
      continue;
    }
    try {
      return await downloadResponse.json() as FK.Report;
    } catch (e) {
      logger.err(`perfect-shards: failed to parse durations response: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
  }
  logger.warn(`perfect-shards: timed out waiting for historical durations`);
}

async function resolveAccessToken(explicit: string | undefined, flakinessProject: string | undefined, logger: ShardLogger): Promise<string | undefined> {
  const fromOptionOrEnv = explicit ?? process.env.FLAKINESS_ACCESS_TOKEN;
  if (fromOptionOrEnv) return fromOptionOrEnv;
  const oidc = GithubOIDC.initializeFromEnv();
  if (oidc && flakinessProject) {
    try {
      return await oidc.createFlakinessAccessToken(flakinessProject);
    } catch (e) {
      logger.err(`perfect-shards: GitHub OIDC token exchange failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return undefined;
}

function computeShardGroupKey(opts: {
  runnerName: string;
  runnerVersion?: string;
  envNames: string[];
}): string {
  const envs = [...opts.envNames].sort().join('-');
  const raw = [opts.runnerName, opts.runnerVersion ?? 'unknown', envs].map(sanitize).join('_');
  if (raw.length <= 250) return raw;
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 12);
  return raw.slice(0, 237) + '_' + hash;
}

function sanitize(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'x';
}

async function postJSON<T>(url: string, bearer: string, body: unknown): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok)
      return { ok: false, error: `${response.status} ${url} ${await response.text()}` };
    return { ok: true, value: await response.json() as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
