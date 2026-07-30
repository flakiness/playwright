[![Tests](https://img.shields.io/endpoint?url=https%3A%2F%2Fflakiness.io%2Fapi%2Fbadge%3Finput%3D%257B%2522badgeToken%2522%253A%2522badge-5VBxhivD3vj6ItXSEL9heM%2522%257D)](https://flakiness.io/flakiness/playwright)

# Flakiness.io Playwright Reporter

A custom Playwright test reporter that generates Flakiness Reports from your Playwright test runs. The reporter automatically converts Playwright test results into the standardized [Flakiness JSON format](https://github.com/flakiness/flakiness-report), capturing test outcomes, attachments, system utilization, and environment information.

## Table of Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Balanced Sharding](#balanced-sharding)
  - [Using the last run as duration hints](#using-the-last-run-as-duration-hints)
  - [Building a timings file from multiple reports](#building-a-timings-file-from-multiple-reports)
  - [Fetching a timings file from Flakiness.io](#fetching-a-timings-file-from-flakinessio)
  - [Commit the timings file](#commit-the-timings-file)
  - [Sharding granularity](#sharding-granularity)
  - [What the reporter prints](#what-the-reporter-prints)
  - [Debugging test failures](#debugging-test-failures)
- [Uploading Reports](#uploading-reports)
- [Viewing Reports](#viewing-reports)
- [Features](#features)
  - [Attachment Handling](#attachment-handling)
  - [Environment Detection](#environment-detection)
  - [CI Integration](#ci-integration)
- [Configuration Options](#configuration-options)
  - [`flakinessProject?: string`](#flakinessproject-string)
  - [`title?: string`](#title-string)
  - [`endpoint?: string`](#endpoint-string)
  - [`token?: string`](#token-string)
  - [`outputFolder?: string`](#outputfolder-string)
  - [`open?: 'always' | 'never' | 'on-failure'`](#open-always--never--on-failure)
  - [`collectBrowserVersions?: boolean`](#collectbrowserversions-boolean)
  - [`disableUpload?: boolean`](#disableupload-boolean)
  - [`shardBalancing?: { timingsFile: string }`](#shardbalancing--timingsfile-string-)
- [Environment Variables](#environment-variables)
- [Example Configuration](#example-configuration)

## Requirements

- Node.js 20.17.0 or higher on the Node 20 line, or Node.js 22.9.0 or higher
- Playwright 1.57.0 or higher (1.62.0 or higher for [balanced sharding](#balanced-sharding))
- Node.js project with a git repository (for commit information)
- Valid Flakiness.io access token (for uploads)

## Installation

```bash
npm install @flakiness/playwright
```

## Quick Start

Add the reporter to your `playwright.config.ts`:

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [
    ['@flakiness/playwright', {
      flakinessProject: 'my-org/my-project',
    }]
  ],
});
```

Run your tests. The report will be automatically generated in the `./flakiness-report` folder:

```bash
npx playwright test
```

View the interactive report:

```bash
npx flakiness show ./flakiness-report
```

## Balanced Sharding

Playwright's native `--shard` splits work by *count*, knowing nothing about how long each one takes. A shard that happens to collect the slow tests becomes the long pole of the whole CI run, while the other shards sit finished and idle.

The reporter's `shardBalancing` option replaces Playwright's native splitting with one driven by **test duration hints**: tests are packed into shards by expected runtime, so every shard finishes at roughly the same time. Configure it once:

```typescript
export default defineConfig({
  reporter: [
    ['@flakiness/playwright', {
      shardBalancing: { timingsFile: 'timings.json' },
    }]
  ],
});
```

— and keep using plain `playwright test`; the regular `--shard` argument now produces balanced shards:

```bash
npx playwright test --shard=1/2
npx playwright test --shard=2/2
```

All other Playwright arguments work as usual (`--project=chromium tests/e2e ...`), and runs without `--shard` are unaffected. Balanced sharding requires Playwright **1.62 or higher**; on older versions the reporter prints a warning and Playwright's native sharding applies.

`shardBalancing` takes a single form — **`{ timingsFile: '<path>' }`** — pointing at a timings file that supplies the duration hints. The rest of this section is about where that file comes from. There are three sources, from simplest to most automated.

### Using the last run as duration hints

The simplest source of duration hints is the report from a previous run — point `timingsFile` directly at it:

```typescript
shardBalancing: { timingsFile: './flakiness-report/report.json' }
```

This works out of the box: as long as the previous run covered your tests, its recorded durations drive the balancing. Tests missing from the file simply fall back to a default weight, so a stale or partial report still produces a valid (if less balanced) split.

It has two drawbacks, though:

- A full Flakiness report carries far more than durations — steps, errors, annotations, stdio — so it's a bulky file to cart around as a balancing hint.
- It represents a **single** run. One run's durations are noisy, and a sharded run only covers that shard's tests.

### Building a timings file from multiple reports

The `flakiness-playwright-timings build` command solves both drawbacks: it distills one or more Flakiness reports into a single compact `timings.json` that contains only test durations:

```bash
npx flakiness-playwright-timings build report-1.json report-2.json report-3.json -o timings.json
```

It accepts one or more report files and writes a distilled timings report (to `timings.json` by default, or the `-o` path). Distillation:

- **Tracks durations per environment name.** Durations are keyed by environment *name*, environment metadata (OS, worker count, `FK_ENV_*` parameters) is ignored.
- **Sums retries, maxes across runs.** Within a single run, a test's retry attempts are summed (a test that only passes on its third try genuinely costs all three). Across runs, the per-run costs are combined with `max`, provisioning each shard for the slowest observed run rather than an average.
- **Keeps only what the balancer needs.** Only the absolutely necessary information is stored, keeping the file size small.

Then feed the result to the reporter:

```typescript
shardBalancing: { timingsFile: 'timings.json' }
```

### Fetching a timings file from Flakiness.io

If your reports are uploaded to Flakiness.io, you don't need to collect report files yourself — the service already has your historic durations, aggregated across many runs. The `flakiness-playwright-timings fetch` command snapshots them into a timings file: it runs `playwright test --list` to discover the current test set, fetches its historical durations from the Flakiness.io Durations API, and distills them into a timings report:

```bash
# prepare step — snapshot the current durations
npx flakiness-playwright-timings fetch -o timings.json
# run step — a fixed shard split, balanced by real history
npx playwright test --shard=1/3
```

Fetching requires the reporter to be configured with your `flakinessProject`, and authenticates the same way uploads do (the `token` reporter option, `FLAKINESS_ACCESS_TOKEN`, or CI OIDC on GitHub Actions and GitLab CI/CD).

### Commit the timings file

However you produce `timings.json` — `build` or `fetch` — commit it to your repository and point `shardBalancing.timingsFile` at the committed file.

A committed timings file has a few nice properties:

- **The shard split is stable.** It only changes when the file changes — in a commit you can review and revert — not because historic data shifted underneath you.
- **Pull requests just work.** Sharding needs no Flakiness.io access at run time, so PRs from forks (which typically can't read repository secrets) shard the same way as trunk builds.
- **Runs are reproducible.** Checking out an old commit reproduces the exact shard split it ran with.

The file tolerates going stale: new tests fall back to a default weight, and entries for deleted tests are ignored. Refresh it every once in a while — for example, with a scheduled CI job that runs `flakiness-playwright-timings fetch` and opens a pull request with the result.

### Sharding granularity

Balanced sharding splits work into the same indivisible units that Playwright assigns to its workers, then balances those units across shards by historical duration. The unit follows your Playwright parallelism configuration:

- **Default** — a whole spec **file** is one unit. Playwright runs a file's tests in order on a single worker, so a file is never split across shards.
- **`fullyParallel: true`** — every **test** is its own unit, giving the finest-grained, most even balancing.
- **`test.describe.serial()`** (or `test.describe.configure({ mode: 'serial' })`) — the suite stays together as one unit, in order, even under `fullyParallel`.
- **`test.describe.parallel()`** — splits that suite's tests into per-test units even when the project is not fully parallel.

For the most even shards, enable Playwright's [`fullyParallel`](https://playwright.dev/docs/test-parallel) so each test can be balanced independently:

```typescript
export default defineConfig({
  fullyParallel: true,
  // ...
});
```

Without it, balancing is per-file — a single large spec file is one unit and lands entirely on one shard. You can also opt in selectively by wrapping the tests you want spread across shards in `test.describe.parallel()`.

### What the reporter prints

With `shardBalancing` configured, each shard reports its plan before the first test runs:

```
[flakiness.io] balancing 3 shards
[flakiness.io]   timings file:   /repo/timings.json
[flakiness.io]   duration hints: 412/430 tests (96%), the rest default to 1.0s
[flakiness.io]   shard loads:    1=8m 12s, 2=8m 40s, 3=8m 51s
[flakiness.io]   balance:        96%
[flakiness.io] Running shard 2/3: 8m 40s of work, ~2m 10s across 4 workers
```

- **timings file** is the resolved path the duration hints were read from. `shardBalancing.timingsFile` is resolved against the working directory, so this is worth checking first whenever a split looks wrong.
- **duration hints** is how much of the current test set your timings file actually covers. Tests it doesn't know about are priced at a 1 second default, so a low percentage means the split is closer to a guess than a balance. Refresh the timings file when this drops.
- **shard loads** is the predicted work of every shard, keyed by shard number. Every shard prints the same line, since each one runs the identical balancing over the identical corpus.
- **balance** is the average shard load as a share of the heaviest one, so 100% means every shard carries the same work. Shards run in parallel and the run is paid for at the heaviest shard on all of them, which makes the remainder the share of that purchased capacity sitting idle: at 96%, 4% of your shard time does nothing. A poor balance usually points at indivisible units of work (a long serial suite, or a setup project only some shards need) rather than at a bad timings file.
- **Running shard** is the work assigned to this shard. All figures are serial sums of test durations; the wall time estimate divides that by the configured worker count, and is omitted when running with a single worker.

When the run finishes, the shard reports what it actually cost:

```
[flakiness.io] Shard 2/3 finished: predicted 8m 40s of work, actual 9m 12s (+6%)
```

A small percentage means the timings file still describes this suite well. A large one, pointing the same direction on every shard, usually means the timings are stale or were recorded on different hardware. A uniform scaling factor (every test 30% slower on a smaller CI machine) barely affects the balancing itself, since only the relative weights matter.

### Debugging test failures

Balanced sharding regroups tests: tests that used to share a shard may now run apart, and tests that never met before may now run together. If a shard starts failing after re-balancing — while the same tests pass under Playwright's native `--shard` — the usual culprit is a hidden dependency between tests: one test relies on state (a file, a database row, a signed-in session) that another test happens to set up or clobber.

Here is how to pinpoint the interfering tests. Say shard `4/8` is the one failing:

1. **Pin the timings.** Debugging needs a shard split that doesn't move underneath you, so use a fixed timings file — either [build one from reports](#building-a-timings-file-from-multiple-reports) or [fetch one from Flakiness.io](#fetching-a-timings-file-from-flakinessio) — and point `shardBalancing.timingsFile` at it. Skip this step if you already run with a committed `timings.json`.

2. **Dump the shard's test list.** Playwright's `--list` flag prints the balanced shard's tests instead of running them; keep the test lines:

   ```bash
   npx playwright test --shard=4/8 --list | grep '›' > tests.txt
   ```

3. **Reproduce with plain Playwright.** Feed the list back via Playwright's `--test-list` (without `--shard`, so balancing stays out of the way):

   ```bash
   npx playwright test --test-list=tests.txt --workers=1
   ```

   A single worker makes the run deterministic — every attempt executes the same tests in the same order. If the failure reproduces only with multiple workers, the interference is *between* workers (tests in different workers competing for a shared resource) rather than a within-worker ordering problem, but the minimization below works the same way.

4. **Minimize the list.** Now shrink `tests.txt` until only the interfering tests remain: comment out a chunk of lines (the `--test-list` format treats lines starting with `#` as comments), re-run, and keep whichever half still fails. Repeat. You'll typically converge on a pair — one test that pollutes shared state, and one that trips over it.

5. **Fix the dependency.** Make both tests self-contained: set up the state each test needs in the test itself (or a fixture), and clean up whatever it changes. Once the tests are hermetic, they'll pass regardless of which shard — or neighbors — they get.

## Uploading Reports

Reports are automatically uploaded to Flakiness.io in the `onExit()` hook. Authentication is resolved in the following order, and the first available method wins:

- **Access token**: Provide a token via the `token` option or the `FLAKINESS_ACCESS_TOKEN` environment variable.
- **GitHub OIDC**: When running in GitHub Actions with no access token, the reporter can authenticate using GitHub's OIDC token. This requires three conditions:
  1. The `flakinessProject` option must be set to your Flakiness.io project identifier (`org/project`).
  2. The Flakiness.io project must be bound to the GitHub repository that runs the GitHub Actions workflow.
  3. The workflow must grant the `id-token: write` permission.
- **GitLab OIDC**: When running in GitLab CI/CD with no access token, the reporter can authenticate using a GitLab ID token. GitLab mints ID tokens when the job starts, so the job must declare one named `FLAKINESS_ID_TOKEN` whose audience is your project identifier:

  ```yaml
  test:
    id_tokens:
      FLAKINESS_ID_TOKEN:
        aud: my-org/my-project   # must match the `flakinessProject` option
    script:
      - npx playwright test
  ```

  The `flakinessProject` option must be set, and the Flakiness.io project must be bound to the GitLab project running the pipeline.

If no method is available the upload is skipped, and if an upload fails the report is still available locally in the output folder. Either way the test run is unaffected.

## Viewing Reports

After test execution, you can view the report using:

```bash
npx flakiness show ./flakiness-report
```

## Features

### Attachment Handling

All Playwright test attachments (screenshots, traces, videos, etc.) are automatically:
- Included in the report
- Hashed for deduplication
- Written to the `attachments/` directory in the output folder

If an attachment file cannot be accessed, a warning is displayed but the report generation continues.


### Environment Detection

For each Playwright project, the reporter creates a unique environment that includes:
- Project name and metadata
- Operating system information (detected automatically)
- Browser information (if `collectBrowserVersions` is enabled)
- Custom environment variables prefixed with `FK_ENV_`

Environment variables prefixed with `FK_ENV_` are automatically included in the environment's `userSuppliedData`. The prefix is stripped and the key is converted to lowercase.

**Example:**

```bash
export FK_ENV_DEPLOYMENT=staging
export FK_ENV_REGION=us-east-1
```

This will result in the environment containing:
```json
{
  "userSuppliedData": {
    "deployment": "staging",
    "region": "us-east-1"
  }
}
```

Flakiness.io will create a dedicated history for tests executed in each unique environment. This means tests run with `FK_ENV_DEPLOYMENT=staging` will have a separate timeline from tests run with `FK_ENV_DEPLOYMENT=production`, allowing you to track flakiness patterns specific to each deployment environment.

### CI Integration

The reporter automatically detects CI environments and includes:
- CI run URLs (GitHub Actions, Azure DevOps, Jenkins, GitLab CI)
- Git commit information
- System environment data

## Configuration Options

The reporter accepts the following options:

### `flakinessProject?: string`

The Flakiness.io project identifier in `org/project` format. Required for CI OIDC authentication. When set, and when the Flakiness.io project is bound to the repository running the pipeline, the reporter authenticates uploads via a GitHub Actions or GitLab CI/CD OIDC token with no access token required. See [Uploading Reports](#uploading-reports) for the per-provider requirements.

```typescript
reporter: [
  ['@flakiness/playwright', { flakinessProject: 'my-org/my-project' }]
]
```

### `title?: string`

Optional human-readable report title. Typically used to name a CI run, matrix shard, or other execution group. Defaults to the `FLAKINESS_TITLE` environment variable if set; otherwise a run with `--shard=N/M` is titled `Shard N/M`, and an unsharded run has no title.

```typescript
reporter: [
  ['@flakiness/playwright', { title: 'Shard 1/4 — Linux Chrome' }]
]
```

### `endpoint?: string`

Custom Flakiness.io endpoint URL for uploading reports. Defaults to the `FLAKINESS_ENDPOINT` environment variable, or `https://flakiness.io` if not set.

Use this option to point to a custom or self-hosted Flakiness.io instance.

```typescript
reporter: [
  ['@flakiness/playwright', { endpoint: 'https://custom.flakiness.io' }]
]
```

### `token?: string`

Access token for authenticating with Flakiness.io when uploading reports. Defaults to the `FLAKINESS_ACCESS_TOKEN` environment variable.

If no token is provided, the report will still be generated locally but won't be uploaded automatically.

```typescript
reporter: [
  ['@flakiness/playwright', { token: 'your-access-token' }]
]
```

### `outputFolder?: string`

Directory path where the Flakiness report will be written. Defaults to `flakiness-report` in the current working directory, or the `FLAKINESS_OUTPUT_DIR` environment variable if set.

```typescript
reporter: [
  ['@flakiness/playwright', { outputFolder: './test-results/flakiness' }]
]
```

### `open?: 'always' | 'never' | 'on-failure'`

Controls when the report viewer should automatically open in your browser after test completion.

- **`'never'`** (default): Never automatically opens the report. The reporter prints the `flakiness show` command instead
- **`'on-failure'`**: Opens the report only if tests failed and running in an interactive terminal (not in CI)
- **`'always'`**: Always opens the report after test completion (when running in an interactive terminal)

```typescript
reporter: [
  ['@flakiness/playwright', { open: 'always' }]
]
```

### `collectBrowserVersions?: boolean`

When enabled, the reporter will launch each browser type used in your Playwright projects to detect and record the actual browser version. This information is added to the environment metadata.

**Note:** This option requires launching browsers, which adds overhead to report generation. Enable only when browser version information is critical for your analysis.

```typescript
reporter: [
  ['@flakiness/playwright', { collectBrowserVersions: true }]
]
```

### `disableUpload?: boolean`

When set to `true`, the reporter will skip uploading the report to Flakiness.io. The report is still generated locally in the output folder. This is useful for local development or testing the reporter itself. Can also be enabled via the `FLAKINESS_DISABLE_UPLOAD` environment variable.

```typescript
reporter: [
  ['@flakiness/playwright', { disableUpload: true }]
]
```

### `shardBalancing?: { timingsFile: string }`

Enables [balanced sharding](#balanced-sharding) for runs with Playwright's `--shard=N/M` argument: instead of Playwright's count-based native split, tests are packed into shards by expected runtime. `{ timingsFile: '<path>' }` reads duration hints from a timings file — a distilled report from `flakiness-playwright-timings`, or any previous run's `report.json`. Requires Playwright 1.62+. Runs without `--shard` are unaffected.

```typescript
reporter: [
  ['@flakiness/playwright', { shardBalancing: { timingsFile: 'timings.json' } }]
]
```

## Environment Variables

The reporter respects the following environment variables:

- **`FLAKINESS_ACCESS_TOKEN`**: Access token for Flakiness.io uploads (equivalent to `token` option)
- **`FLAKINESS_ENDPOINT`**: Custom Flakiness.io endpoint URL (equivalent to `endpoint` option)
- **`FLAKINESS_OUTPUT_DIR`**: Output directory for reports (equivalent to `outputFolder` option)
- **`FLAKINESS_TITLE`**: Report title (equivalent to `title` option)
- **`FLAKINESS_DISABLE_UPLOAD`**: When set, disables report upload (equivalent to `disableUpload` option)
- **`FLAKINESS_ID_TOKEN`**: GitLab CI/CD ID token used for OIDC authentication. Set by GitLab for jobs that declare it under `id_tokens:` (see [Uploading Reports](#uploading-reports))



## Example Configuration

Here's a complete example with all options:

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [
    ['@flakiness/playwright', {
      flakinessProject: 'my-org/my-project',
      title: 'My Test Run',
      endpoint: process.env.FLAKINESS_ENDPOINT,
      token: process.env.FLAKINESS_ACCESS_TOKEN,
      outputFolder: './flakiness-report',
      open: 'on-failure',
      collectBrowserVersions: false,
      disableUpload: false,
      shardBalancing: { timingsFile: 'timings.json' },
    }]
  ],
  // ... rest of your config
});
```
