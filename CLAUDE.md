# fk-playwright

Custom Playwright Test reporter that emits Flakiness.io reports. Single class in `src/playwright-test.ts`. Thin adapter — schema lives in `@flakiness/flakiness-report` (`FK.*` types), helpers in `@flakiness/sdk` (`ReportUtils`, `GitWorktree`, `CIUtils`, CPU/RAM samplers, `writeReport`/`uploadReport`/`showReport`).

## Toolchain

- **pnpm** (not npm/yarn). Use `pnpm install`, `pnpm build`, `pnpm test`.
- Node 22+, Playwright 1.57+.
- Build: Kubik + esbuild (`build.mts`) → ESM, `node22` target, `bundle: false`, then `tsc` for `.d.ts`.

## Invariants — do not break

1. **Never throw from the reporter.** Degrade via `warn()`/`err()` (`[flakiness.io]` prefix) and continue. A reporter that crashes breaks the user's test run.
2. **Keep it one file.** All reporter logic stays in `src/playwright-test.ts`. Push schema/transport changes upstream to `@flakiness/sdk` instead of growing this repo.
3. **Each Playwright project → one Flakiness "environment".** `FK_ENV_*` env vars get folded into `userSuppliedData` (prefix stripped, lowercased).

## Tests

End-to-end, no mocks. `tests/utils.ts:generateFlakinessReport` writes a fixture project under `/tmp/flakiness-playwright/...`, `git init`s + commits it, runs the real `playwright` CLI via `execSync`, reads the resulting report. New tests in `tests/*.spec.ts` follow this pattern; use `assertCount`/`assertStatus` helpers.

## Releasing

Tag-driven: `pnpm version <bump>` → `git push --follow-tags` → create GitHub Release → CI publishes to npm. Prereleases (`-alpha` etc.) auto-publish to `@next`. Don't `npm publish` manually.
