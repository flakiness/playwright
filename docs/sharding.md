# Balanced sharding

`src/sharding.ts` decides which tests run on each shard. The goal is the same as
Playwright's built-in `--shard`, but instead of slicing tests into equal *counts*
it uses **historical per-test durations** (fetched from Flakiness.io) to make
every shard finish at roughly the same wall-clock time — i.e. minimize the
*makespan* (the slowest shard).

This is the classic multiprocessor-scheduling problem, which is NP-hard, so we
use a heuristic. The interesting part is that real Playwright suites are not just
a flat list of tests:

- **`.serial` suites must stay on one shard.** Their tests depend on each other,
  so they cannot be split.
- **`repeat-each` instances stay together** for the same reason.
- **Dependency projects (setup / teardown) are re-run on every shard that needs
  them.** A heavy `setup` project that builds a database or signs in a user is
  *duplicated* work on each shard. Splitting the tests that depend on it across
  more shards can cost more than it saves.

## The unit of sharding: a "group"

We never split atomic units. `prepareShardableTestEntries` collapses tests into
**groups**, where a group is one of:

- an outermost `.serial` suite (all its tests, in order),
- all `repeat-each` instances of a test,
- a single standalone test.

Each group carries:

- `duration` — the summed historical duration of its tests (P50 of all known
  durations, or 1s, when a test has no history),
- `deps` — the project dependency closure it needs (setup **and** teardown
  projects), each with its own total duration.

## The cost model

A shard's cost is the work it actually performs:

```
shard cost = Σ (duration of groups on the shard)
           + Σ (duration of each dependency project at least one group needs)
```

The second term is the subtle one: a dependency project is charged **once per
shard** that needs it, never per test. Two groups on the same shard that share a
setup pay for it once; the same two groups on different shards pay for it twice.

## The algorithm

### 1. Cluster by dependency signature

Groups that need the *exact same* set of dependency projects are collected into a
**cluster**. A cluster pays for its setup together, so we balance it as a unit.
Dependency-free tests form one big cluster with no setup cost.

### 2. Decide how far to spread each cluster

For a cluster with total test work `W` and setup cost `D` (the summed duration of
its dependency projects), we choose how many shards `k` to spread it across:

```
k = D == 0
    ? min(shards, groups)                       // free to spread anywhere
    : clamp(floor(W / D), 1, min(shards, groups))
```

The rule for `D > 0` reads: **only duplicate a setup onto another shard while
each shard still does at least as much real test work as the setup costs.**
Splitting `W` across `k` shards gives each shard `W / k` of useful work; once that
drops below `D`, the shard would spend more time on setup than on tests, so we
stop spreading.

- A single heavy `setup` with a handful of cheap dependent tests
  (`W` ≪ `D`) → `k = 1`: keep them together, run setup once.
- A genuinely heavy dependent suite (`W` ≫ `D`) → `k` grows up to the shard
  count: parallelize it, accepting the duplicated setup.
- `.serial` suites and `repeat-each` groups are single atomic groups, so
  `min(shards, groups)` already pins a lone serial suite to one shard.

### 3. Place clusters, dependency-bearing ones first

We sort clusters so that **clusters with setup go first** (heaviest first,
counting one setup copy per shard they will occupy), and the dependency-free
cluster goes last. Setup-bearing clusters claim the shards they need, and the
flexible dependency-free tests then fill whatever capacity is left — which is
exactly what balances the example below.

For each cluster we:

1. **Reserve its `k` home shards**: the `k` cheapest shards to host it, where
   "cheapest" prefers shards that already run the shared dependencies (so we do
   not pay for them twice) and otherwise the least loaded ones.
2. **Distribute its groups** across those home shards, largest first, always
   choosing the shard that ends up least loaded (Longest-Processing-Time
   greedy). Group order within a shard is preserved, so `.serial` suites keep
   their declaration order.

## Worked example

```
setup   : 1 test,  weight 100   (dependency of "app")
app     : 10 tests, weight 1 each, depends on setup
unit    : 110 tests, weight 1 each, no dependencies
                                                        2 shards
```

- `app` cluster: `W = 10`, `D = 100` → `k = floor(10/100) = 0` → clamped to `1`.
  Kept together. It claims shard A: `setup (100) + 10 app = 110`.
- `unit` cluster: `D = 0` → spreads across both shards. Shard A is already at
  110, so all 110 unit tests flow onto shard B: `110`.

Result: **110 / 110**. Splitting `app` across both shards instead would run the
weight-100 setup twice and yield **160 / 160**.
