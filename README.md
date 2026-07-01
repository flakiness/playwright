[![Tests](https://img.shields.io/endpoint?url=https%3A%2F%2Fflakiness.io%2Fapi%2Fbadge%3Finput%3D%257B%2522badgeToken%2522%253A%2522badge-5VBxhivD3vj6ItXSEL9heM%2522%257D)](https://flakiness.io/flakiness/playwright)

# Flakiness.io Playwright Reporter

A custom Playwright test reporter that generates Flakiness Reports from your Playwright test runs. The reporter automatically converts Playwright test results into the standardized [Flakiness JSON format](https://github.com/flakiness/flakiness-report), capturing test outcomes, attachments, system utilization, and environment information.

## Table of Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Balanced Sharding](#balanced-sharding)
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
- [Environment Variables](#environment-variables)
- [Example Configuration](#example-configuration)

## Requirements

- Playwright 1.57.0 or higher
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

Balanced sharding uses historical test durations from Flakiness.io to generate Playwright test lists with more even shard runtimes.

First, make sure the reporter is configured with your Flakiness.io project:

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

Then run each shard with `flakiness-playwright-shard` instead of `playwright test`:

```bash
npx flakiness-playwright-shard --shard=1/2
npx flakiness-playwright-shard --shard=2/2
```

Any additional arguments are passed through to `playwright test`:

```bash
npx flakiness-playwright-shard --shard=1/2 --project=chromium tests/e2e
```

### Sharding from a local timings file

By default durations are fetched from the Flakiness.io Durations API. These change as more and more
data gets uploaded to the service, allowing for more precise test duration predictions.

In real-world large test suites, though, tests are not hermetic and do rely on their order and
specific sharding. So instead of fetching dynamic test duration predicutions from the Flakiness.io,
clients can pass a `--timings=<file>` flag to use previous run test durations as balancing hints:

```bash
npx flakiness-playwright-shard --shard=1/2 --timings=./flakiness-report/report.json
```

Tests missing from the file fall back to a default weight, so a stale or partial timings file still produces a valid (if less balanced) split.

### Sharding granularity

`flakiness-playwright-shard` splits work into the same indivisible units that Playwright assigns to its workers, then balances those units across shards by historical duration. The unit follows your Playwright parallelism configuration:

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

## Uploading Reports

Reports are automatically uploaded to Flakiness.io in the `onExit()` hook. Authentication can be done in two ways:

- **Access token**: Provide a token via the `token` option or the `FLAKINESS_ACCESS_TOKEN` environment variable.
- **GitHub OIDC**: When running in GitHub Actions, the reporter can authenticate using GitHub's OIDC token — no access token needed. This requires two conditions:
  1. The `flakinessProject` option must be set to your Flakiness.io project identifier (`org/project`).
  2. The Flakiness.io project must be bound to the GitHub repository that runs the GitHub Actions workflow.

If upload fails, the report is still available locally in the output folder.

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

The Flakiness.io project identifier in `org/project` format. Used for GitHub OIDC authentication — when set, and the Flakiness.io project is bound to the GitHub repository running the workflow, the reporter authenticates uploads via GitHub Actions OIDC token with no access token required.

```typescript
reporter: [
  ['@flakiness/playwright', { flakinessProject: 'my-org/my-project' }]
]
```

### `title?: string`

Optional human-readable report title. Typically used to name a CI run, matrix shard, or other execution group. Defaults to the `FLAKINESS_TITLE` environment variable if set, or empty otherwise.

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

- **`'on-failure'`** (default): Opens the report only if tests failed and running in an interactive terminal (not in CI)
- **`'always'`**: Always opens the report after test completion (when running in an interactive terminal)
- **`'never'`**: Never automatically opens the report

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

## Environment Variables

The reporter respects the following environment variables:

- **`FLAKINESS_ACCESS_TOKEN`**: Access token for Flakiness.io uploads (equivalent to `token` option)
- **`FLAKINESS_ENDPOINT`**: Custom Flakiness.io endpoint URL (equivalent to `endpoint` option)
- **`FLAKINESS_OUTPUT_DIR`**: Output directory for reports (equivalent to `outputFolder` option)
- **`FLAKINESS_TITLE`**: Report title (equivalent to `title` option)
- **`FLAKINESS_DISABLE_UPLOAD`**: When set, disables report upload (equivalent to `disableUpload` option)



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
    }]
  ],
  // ... rest of your config
});
```
