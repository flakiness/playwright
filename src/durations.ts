import { FlakinessReport as FK } from '@flakiness/flakiness-report';
import { GithubOIDC } from '@flakiness/sdk';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { brotliCompress } from 'node:zlib';

const brotliCompressAsync = promisify(brotliCompress);

export async function fetchHistoricalDurations(
  report: FK.Report,
  options: {
    flakinessAccessToken?: string,
    flakinessEndpoint?: string,
  },
): Promise<FK.Report> {
  const endpoint = (options.flakinessEndpoint ?? process.env.FLAKINESS_ENDPOINT ?? 'https://flakiness.io').replace(/\/+$/, '');

  let token = options.flakinessAccessToken;
  if (!token && report.flakinessProject)
    token = await GithubOIDC.initializeFromEnv()?.createFlakinessAccessToken(report.flakinessProject);

  if (!token)
    throw new Error(`perfect-shards: no Flakiness access token available (set FLAKINESS_ACCESS_TOKEN, pass token, or run in GitHub Actions with id-token: write)`);

  // Shard group key makes sure that all shards fetch the same timings.
  const shardGroupKey = createHash('sha1').update(JSON.stringify({
    testRunnerName: report.testRunner?.name ?? 'unknown',
    testRunnerVersion: report.testRunner?.version ?? 'unknown',
    envs: report.environments.map(env => env.name).sort(),
  })).digest('hex');

  const createRes = await postJSON<{ testDurationsToken: string; uploadUrl: string }>(
    `${endpoint}/api/testDurations/create`,
    token,
    { commitId: report.commitId, shardGroupKey },
  );
  if (!createRes.ok)
    throw new Error(`perfect-shards: testDurations.create failed: ${createRes.error}`);

  const compressed = await brotliCompressAsync(Buffer.from(JSON.stringify(report)));
  const uploadResponse = await fetch(createRes.value.uploadUrl, {
    method: 'PUT',
    // Workaround https://github.com/nodejs/node/issues/56645
    keepalive: process.platform !== 'win32',
    headers: {
      'Content-Type': 'application/json',
      'Content-Encoding': 'br',
      'Content-Length': String(compressed.byteLength),
    },
    body: new Uint8Array(compressed),
  });
  if (!uploadResponse.ok)
    throw new Error(`perfect-shards: input upload failed (${uploadResponse.status} ${uploadResponse.statusText})`);

  const submitRes = await postJSON<{ downloadUrl: string }>(
    `${endpoint}/api/testDurations/submit`,
    createRes.value.testDurationsToken,
    undefined,
  );
  if (!submitRes.ok)
    throw new Error(`perfect-shards: testDurations.submit failed: ${submitRes.error}`);

  const deadlineMs = Date.now() + 1000 * 60;
  while (Date.now() < deadlineMs) {
    const downloadResponse = await fetch(submitRes.value.downloadUrl, {
      // Workaround https://github.com/nodejs/node/issues/56645
      keepalive: process.platform !== 'win32',
    });
    if (!downloadResponse.ok) {
      await new Promise(x => setTimeout(x, 1000));
      continue;
    }
    try {
      return await downloadResponse.json() as FK.Report;
    } catch (e) {
      throw new Error(`perfect-shards: failed to parse durations response: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`perfect-shards: timed out waiting for historical durations`);
}

async function postJSON<T>(url: string, bearer: string, body: unknown): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      // Workaround https://github.com/nodejs/node/issues/56645
      keepalive: process.platform !== 'win32',
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
