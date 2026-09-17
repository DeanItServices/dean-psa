# 09-01 — E2E first real run against a browser

**Status**: Complete with Warnings
**Wave**: 1
**Agent**: testing-qa-verification-specialist
**Date**: 2026-09-17
**Files modified**: `e2e/sla-tracking.spec.ts` (1 deletion)

## The browser install — and a correction to this phase's own premise

The plan warned that a browser layout mismatch might need a manual workaround. **It did not, and the
warning was wrong.**

The hand-built symlinks from the Phase 8 session were still on disk, bridging the paths
`@playwright/test ^1.62.1` expects (`chromium_headless_shell-1234/...`) to the image's `-1194`
build — **including forged zero-byte `INSTALLATION_COMPLETE` and `DEPENDENCIES_VALIDATED`
sentinels**, the files Playwright checks to decide a browser is installed. That is what made the
bridge invisible to tooling.

They were removed, then:

```
npx playwright install chromium     # EXIT=0, first attempt, no fallback
```

Chrome for Testing 151.0.7922.34 fetched from `cdn.playwright.dev`, which the egress proxy serves
fine. Verified genuine: 197 MB stripped ELF, `find … -type l` → 0 symlinks.

**Task 1's required answer: yes — a contributor on a clean checkout can run this suite with no
manual step.** `09-CONTEXT.md` and spec §3.7 have been corrected; as written they would have sent
the next agent hunting for a fallback that isn't needed.

## The run — 45/45, six times, on a real browser

Green on the **first** run after the clean install, no fixes required. Six runs total:

| Runs | Workers | Result |
|---|---|---|
| 1 (first real run) | 2 | 45 passed, 1.2m |
| 2–4 (task 3 loop) | 2 | 45 passed each |
| 5 | 4 | 45 passed, 50.1s |
| 6 | 6 | 45 passed, 52.8s |

0 failed, 0 flaky. Every run ended with the teardown fixture guard. The `[auth][error]
CredentialsSignin` traces are expected — specs deliberately exercise failed logins.

Independently re-run by the coordinator on a fresh database: **45 passed**.

## The parallelism finding

**No failure attributable to shared-database parallelism was observed across 6 runs, at 2, 4 and 6
workers.**

The finding has a **mechanism**, not just a run count. `user-lifecycle`, `bootstrap-admin` and
`last-active-admin` each compute a module-scope
`RUN_ID = ${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`. Module scope means
**per worker process**, so concurrent workers mint disjoint user identities and never contend for
the same rows. Shared seeded fixtures are read-only, enforced by the teardown baseline diff.
`last-active-admin` is already serialised by `fullyParallel: false` + `dependencies`.

The agent deliberately went past the plan's three runs: Playwright defaults to `cpus/2` = 2 workers
on this 4-CPU box, and green at 2 workers is weak evidence for a race.

**Honest limit**: covers the `lifecycle` and `last-active-admin` projects only — what
`npm run test:e2e` actually runs — at up to 6 workers. A larger CI box would spawn more. The
isolation is by construction rather than luck, so it should hold, but above 6 is unobserved.

### Recommendation (a recommendation, not a decision)

**Do not introduce a separate test database.** The hazard the exploration doc reserved judgement on
did not materialise, for a structural reason: `RUN_ID` gives per-worker isolation and the shared
fixtures are read-only and baseline-guarded. Revisit if a spec is added that mutates seeded fixture
rows — which the teardown baseline diff would catch.

## Advisory suite — first browser run ever, and it fails

`npm run test:e2e` excludes the `advisory` project. `playwright.config.ts` says advisory has "never
been run against a browser". The agent ran it: **1 passed, 4 failed, 2 skipped.** Root-caused, not
fixed, per the plan's explicit scope instruction.

**Layer 1 — the rate limiter masked everything.** Both 30s timeouts rendered `Too Many Requests`.
`e2e/fixtures.ts`'s `newIsolatedContext()` mints a per-worker `x-forwarded-for` so each context gets
its own rate-limit bucket. **All four passing specs use it; all three advisory specs use the bare
`{ page }` fixture** and share one bucket.

Three controlled runs isolated it:

| Run | Config | Result |
|---|---|---|
| A | 2 workers, default limits | 4 failed, 53.5s, two 30s timeouts |
| B | **1 worker**, default limits | identical 4 failed → **not** a parallelism artifact |
| C | 2 workers, `RATE_LIMIT_*=1000000` | 4 failed but **both timeouts gone**, 53.5s → 20.5s |

Run C needed **zero file changes** — the limits are `envInt`-configurable — so it is a clean
experiment. Database evidence shows the 429 caused real data loss: `assignedToId` was empty after
runs A and B, populated after C. The `assignTicket` POST was being 429'd and silently never
persisted.

**Layer 2 — three of four are one locator defect class**, a locator matching a visible element and a
hidden duplicate:

1. `sla-tracking.spec.ts:101` — `getByText` matches the `<h1>` **and** Next's route announcer. The
   correct pattern already exists at `tickets.spec.ts:104`.
2. `tickets.spec.ts:225` — resolves to the hidden `<option>` in Radix Select's native `<select>`.
   The assignment itself persisted; purely the assertion.
3. `time-entry-to-invoice.spec.ts:90` — same hidden-`<option>` shape.

All three are consistent with specs written but never executed against a browser.

**4. `tickets.spec.ts:188` (kanban drag) — genuinely unresolved.** Status stayed `new` in the
database across all three runs including limits-raised, so not a 429 and not a locator issue. The
obvious product explanation was ruled out: `draggable = can(role, "ticket:manage")` and dispatcher
**is** in `TICKET_MANAGE_ROLES`. That leaves the synthetic pointer sequence failing dnd-kit's
`activationConstraint: { distance: 4 }`, or `closestCorners` not resolving to the targeted
droppable. The agent declined to guess at a fix — the cause may live in `e2e/` or in `src/`, and it
did not own either answer.

## Other findings

- **09-02's change was invisible to the run, as predicted** — no current spec exercises
  `deleteTicket`.
- **The lint warning 09-02 handed to this tree was fixed**: `companyUrl` at
  `e2e/sla-tracking.spec.ts:48` was a dead `const`. `npm run lint` now reports **0 problems**.
- **`playwright.config.ts` claims "ROADMAP Phase 9 owns their first real run and fixing what
  breaks."** The first-run half is now done. **The fixing half is not backed by ROADMAP Phase 9's
  criteria or spec §4 — that gap has no owner.**

## Verification

- `npx playwright install chromium` → exit 0, genuine binary, 0 symlinks
- `npm run test:e2e` → **45 passed** × 6 runs (2/2/2/2/4/6 workers); coordinator re-ran → 45 passed
- `npx tsc --noEmit` → exit 0 — **regression guard, not a negative control**
- `npm run lint` → exit 0, 0 problems — **regression guard, not a negative control**
- `npm run test:e2e:advisory` → exit 1, 1 passed / 4 failed / 2 skipped

### Scope check, negative-controlled

The plan warned it passes vacuously on a clean tree. The agent proved it discriminates:

| Control | Input | Result |
|---|---|---|
| A | real dirty tree (`e2e/` only) | `scope ok` ← **this run's case, real input** |
| B | synthetic `src/lib/actions/tickets.ts` | `SCOPE VIOLATION` ← it can fail |
| C | empty tree | `scope ok` ← the vacuous case |

**Case A applied.** This is the check Phase 8 shipped three times without noticing it could not fail.
