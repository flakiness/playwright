import type { FlakinessReport } from '@flakiness/flakiness-report';
import { ReportUtils } from '@flakiness/sdk';
import { expect } from '@playwright/test';
import http from 'node:http';
import { brotliDecompressSync } from 'node:zlib';

// Fake implementation of the testDurations API used by perfect-shard tests.
// It accepts an uploaded Flakiness report and returns the same report with historical
// durations synthesized from test titles:
//   w=100             every environment gets duration 100
//   w[foo]=13         environment "foo" gets duration 13
//   w=100 w[foo]=none every environment gets 100 except "foo", which gets no duration
// Environment-specific weights take precedence over the default w= value.
export type FakeDurationsServer = {
  endpoint: string;
  [Symbol.dispose]: () => void;
};

export async function startFakeDurationsServer(): Promise<FakeDurationsServer> {
  let durationReport: FlakinessReport.Report | undefined;
  let endpoint = '';
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', endpoint);
      if (request.method === 'POST' && url.pathname === '/api/testDurations/create') {
        jsonResponse(response, {
          testDurationsToken: 'test-durations-token',
          uploadUrl: `${endpoint}/upload`,
        });
        return;
      }

      if (request.method === 'PUT' && url.pathname === '/upload') {
        const body = await readRequestBody(request);
        const json = request.headers['content-encoding'] === 'br' ? brotliDecompressSync(body).toString('utf-8') : body.toString('utf-8');
        const report = JSON.parse(json) as FlakinessReport.Report;
        durationReport = reportWithDurations(report);
        response.writeHead(200);
        response.end();
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/testDurations/submit') {
        jsonResponse(response, { downloadUrl: `${endpoint}/download` });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/download') {
        if (!durationReport) {
          response.writeHead(404);
          response.end();
          return;
        }
        jsonResponse(response, durationReport);
        return;
      }

      response.writeHead(404);
      response.end();
    } catch (e) {
      response.writeHead(500);
      response.end(e instanceof Error ? e.message : String(e));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind fake durations server'));
        return;
      }
      endpoint = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });

  return {
    endpoint,
    [Symbol.dispose]: () => {
      server.close();
    },
  };
}

function readRequestBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function jsonResponse(response: http.ServerResponse, value: unknown) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

function reportWithDurations(report: FlakinessReport.Report): FlakinessReport.Report {
  const result = JSON.parse(JSON.stringify(report)) as FlakinessReport.Report;
  ReportUtils.visitTests(result, test => {
    const attempts: FlakinessReport.RunAttempt[] = [];
    for (const [environmentIdx, env] of result.environments.entries()) {
      const duration = durationFromWeightInTitle(test.title, env.name);
      if (duration === undefined)
        continue;
      attempts.push({
        environmentIdx,
        status: 'passed' as FlakinessReport.TestStatus,
        startTimestamp: 0 as FlakinessReport.UnixTimestampMS,
        duration: duration as FlakinessReport.DurationMS,
      });
    }
    test.attempts = attempts;
  });
  return result;
}

export function durationFromWeightInTitle(title: string, envName: string): number | undefined {
  let defaultDuration: number | undefined;
  const weightPattern = /(?:^|[^\w])w(?:\[([^\]]+)\])?=(none|\d+)(?=$|[^\w])/g;
  for (const match of title.matchAll(weightPattern)) {
    const value = match[2] === 'none' ? undefined : Number(match[2]);
    if (match[1] === envName)
      return value;
    if (match[1] === undefined)
      defaultDuration = value;
  }
  return defaultDuration;
}

/**
 * Test title can encode it's weight, default value and per-env
 * The following are simple tests that verify the behavior.
 */
expect(durationFromWeightInTitle('w=100', 'foo')).toEqual(100);
expect(durationFromWeightInTitle('w=100 w[foo]=12', 'foo')).toEqual(12);
expect(durationFromWeightInTitle('w=100 w[foo]=12', 'bar')).toEqual(100);
expect(durationFromWeightInTitle('w=100 w[foo]=none', 'foo')).toEqual(undefined);
expect(durationFromWeightInTitle('w=100 w[foo]=none', 'ba')).toEqual(100);
expect(durationFromWeightInTitle('w[foo]=12', 'bar')).toEqual(undefined);
