# Balanced Sharding Algorithm

`flakiness-playwright-shard --shard=k/N` splits a Playwright test run across `N` CI machines so that the slowest machine finishes as early as possible. This document describes the partitioning algorithm implemented in [`src/sharding.ts`](../src/sharding.ts).

## The problem

Given historical durations for every test, partition the tests into `N` shards minimizing the *makespan* — the total duration of the slowest shard. Even without constraints this is NP-hard (multiway number partitioning), and Playwright adds three constraints of its own:

1. **Serial suites are atomic.** All tests of a `test.describe.serial(...)` suite must run on one shard, in order.
2. **`repeatEach` instances are atomic.** Repeated instances of one test share a test id and cannot be separated by `--test-list`.
3. **Project dependencies run in full.** If project `app` declares `dependencies: ['setup']` (or a `teardown`), then *every shard* that runs at least one `app` test also runs the *entire* `setup` project. Dependency time is a per-shard "entry fee", paid once no matter how many dependent tests the shard runs.

Constraint 3 is what makes naive approaches fail. The standard greedy heuristic — sort jobs by duration, place each on the shard where it adds the least — decides one test at a time, so it cannot see that scattering a dependent project's tests across shards multiplies the setup fee:

```
Projects: setup (100s, dependency), app (2 tests × 1s, needs setup), unit (100 tests × 1s)
Shards:   2

Greedy:   shard 1 = setup + app·1 + unit·50 = 151s     ← setup paid twice
          shard 2 = setup + app·1 + unit·50 = 151s
Optimal:  shard 1 = setup + app·2           = 102s     ← setup paid once
          shard 2 = unit·100                = 100s
```

Greedy is 50% slower than optimal here, and the gap grows with the setup cost.

## The algorithm

Three steps: build atomic **groups**, merge them into **families**, then place families one at a time.

### 1. Groups

Tests of the leaf projects (projects no other scheduled project depends on) are merged into atomic *shard groups*: an outermost serial suite forms one group, all `repeatEach` instances of a test form one group, every other test is its own group. A group carries:

- `duration` — the sum of historical durations of its tests. Tests with no history get a default: the P50 of all known durations, or 1 second when there is no data at all.
- `deps` — the *dependency closure* of the group's project: every project reachable through `dependencies` and `teardown` links, with its total duration.

Non-leaf projects are never sharded directly — they run implicitly on whichever shards need them, and their durations are accounted through `deps`.

### 2. Families

Groups with the same dependency closure are merged into a *family*:

- `work(F)` — sum of group durations: divisible across shards.
- `setup(F)` — sum of closure project durations: paid in full by every shard the family touches.

Tests with no dependencies — independent browser projects, unit tests — all share the empty closure and form a single zero-setup family.

### 3. Placement

Families are placed one at a time, **most expensive setup first**: high-stakes families commit while shards are still empty, and zero-setup families come last as filler that smooths out the imbalances. Placing one family takes three decisions:

**a. How many shards to span.** Spanning `k` shards splits the family's work `k` ways but re-runs its setup on every extra shard. Both effects bound the makespan from below, so pick `k ∈ [1, min(N, #groups)]` minimizing

```
cost(k) = max( setup(F) + work(F)/k,                      ← family's own shards
               (estimatedTotal + (k−1)·setup(F)) / N )    ← global average
```

where `estimatedTotal` is the projected total work over all shards: current shard loads + all unplaced group work + every dependency project not yet running anywhere, counted once. The first bound falls as `k` grows, the second rises; their crossing is the sweet spot. Ties prefer the wider span (possible only at zero setup, where wider is free parallelism).

This is the step that fixes the greedy trap: for the example above, spanning the `app` family over a second shard saves at most 1s of work but adds 100s of duplicated setup — `cost(2) = 151 > cost(1) = 102` — so the family stays on one shard.

**b. Which shards.** Score every shard with the same two bounds, instantiated for that shard:

```
score(s) = max( load(s) + missing(s) + work(F)/k,
                (Σ loads + missing(s) + remainingWork) / N )
```

`missing(s)` is the part of the family's setup the shard does not run yet, so shards that already run shared dependencies are naturally preferred — a family needing `{setup, db}` gravitates to the shard where a sibling family already pays for `setup`, instead of starting fresh elsewhere. Take the `k` best-scoring shards.

**c. Distribute the groups.** Classic LPT over the chosen shards: groups in decreasing duration, each placed where its marginal cost `load + missing + duration` is lowest. Setup is paid lazily — a chosen shard that ends up receiving no groups pays nothing.

With a single zero-setup family (no project dependencies anywhere), step (a) picks `k = N`, step (b) selects all shards, and step (c) is exactly the classic LPT heuristic with its well-known 4/3 worst-case bound.

## Worked examples

**Setup + teardown** (`setup` 40s with `teardown` 60s, `app` 10×1s depends on `setup`, `unit` 110×1s, 2 shards). The `app` family has `setup = 100`, `work = 10`; `cost(1) = max(110, 110) = 110` vs `cost(2) = max(105, 160) = 160`, so it spans one shard, which then carries 110s. The unit family fills the other shard to 110s. Result: **110 / 110**, the optimum. Greedy produced 160 / 160.

**Splitting that pays for itself** (`setup` 10s, `app` 20×10s depends on it, 2 shards). `cost(1) = max(210, 105) = 210` vs `cost(2) = max(110, 110) = 110`: duplicating a 10s setup to halve 200s of test work is a clear win. Both shards run `setup + 10 tests` = **110 / 110**.

**Dependency affinity** (`setup` 50s, `db` 50s; `web` 1×10s needs `{setup, db}`, `api` 1×10s needs `{setup}`, `unit` 100×1s; 2 shards). `web` places first (setup 100) on shard 1 → 110s. For `api`, shard 1 scores `max(110+0+10, 110) = 120` — its `setup` is already paid — while the empty shard 2 scores `max(0+50+10, 135) = 135`, so `api` joins shard 1. Units fill shard 2. Result: **120 / 100**; placing `api` on shard 2 would have ended at 135 / 135.

## Properties

- **No dependencies ⇒ pure LPT.** Typical single-project or independent-multi-project suites get the proven classic behavior.
- **Setup consolidation.** Small dependent projects never scatter their setup across shards when filler tests can balance the load instead.
- **Justified duplication.** When dependent test work dominates, the family widens and shards knowingly re-run the setup — because the math says it is cheaper than serializing.
- **Deterministic.** Test listing is stable, all sorts are stable, and ties resolve by shard index, so every shard of the same run computes the same global assignment.
- **Lazy setup accounting.** Dependency projects are charged to a shard only when a group actually lands there.

## Limitations

- It is a heuristic. The span decision uses an *estimate* of the final total work that assumes future families will not duplicate setups; processing expensive setups first and re-estimating before each family keeps the estimate honest, but adversarial inputs can still beat it.
- In the span decision, `setup(F)` counts the full closure even when part of it is shared with already-placed families (the per-shard score does account for sharing via `missing(s)`).
- Historical durations are taken as ground truth; tests without history fall back to the P50 default, which can misjudge a brand-new slow test.
