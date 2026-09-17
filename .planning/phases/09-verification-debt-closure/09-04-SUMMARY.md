# 09-04 — Advisory suite fixed; gate widened 45 → 53

**Status**: Complete with Warnings
**Wave**: 3
**Agent**: testing-qa-verification-specialist + engineering-frontend-developer
**Date**: 2026-09-17
**Files modified**: `e2e/fixtures.ts`, `e2e/tickets.spec.ts`, `e2e/sla-tracking.spec.ts`,
`e2e/time-entry-to-invoice.spec.ts`, `package.json` (`test:e2e` only), `playwright.config.ts`
(advisory comment only). **`src/` untouched** — `git status --porcelain src/` → 0 lines.

Coordinator re-verified independently: **53 passed**, **advisory 8 passed**, tsc exit 0, lint clean.

## The finding that overturns two inherited diagnoses

`await page.waitForURL(/\/tickets\/[^/]+$/)` **also matches `/tickets/new`** — the create form the
page is already sitting on. The wait returned instantly, before `createTicket`'s redirect landed.
Demonstrated two ways: `/\/tickets\/[^/]+$/.test("/tickets/new")` → `true`, and a live probe
logging `PROBE_URL=…/tickets/new` immediately after the wait resolved.

Tests that merely assert against the current page usually won the race. The two that **store** the
URL and navigate back later re-opened a blank create form and asserted about a ticket that was
never on screen. Same defect on every `/clients/` wait. Fixed at all 10 sites with `(?!new$)`.

**This overturns 09-01's kanban diagnosis.** All 7 kanban tickets ever created on this machine are
`in_progress` — **including the pre-change baseline run**. The drag simulation was never broken;
neither dnd-kit's `activationConstraint` nor `closestCorners` was at fault. The Server Action
persisted correctly every time; the test then navigated to `/tickets/new` and looked for
"in progress" on an empty form.

**It also subsumes one of the three "locator" failures**: reverting the assignment locator to the
original `getByText(...)` now *passes*, because the hidden `<option>` it used to match lives in the
create form's select — i.e. on the wrong page. Two of three were really locator defects.

`09-01-SUMMARY.md` has been annotated with both corrections in place, since that is the summary a
future reader finds first.

## The root fix

`e2e/fixtures.ts` exports a `test` extended from `base` that overrides the built-in
`extraHTTPHeaders` **option** with `isolatedClientHeaders()`. Each advisory spec changed one import
line. Because it overrides the option rather than a call site, every context Playwright builds
inherits it.

Negative-controlled on the mechanism, not just the outcome: a probe intercepting `**/login` logged
`PROBE_XFF=198.18.1.1` with the extended `test`, and `PROBE_XFF=undefined` after reverting that one
import. Effect of isolation alone: both 30s timeouts gone, runtime 54.1s → 28.6s.

## Locator fixes, each negative-controlled

No `.first()` anywhere — confirmed by grep.

| # | Negative control | Result |
|---|---|---|
| NC1 | revert sla-tracking to `getByText` | **failed** — strict mode, `<h1>` + route announcer |
| NC2a | revert assignment locator | **passed** — not load-bearing, reported above |
| NC2b | expect the wrong user | **failed** — assertion is not vacuous |
| NC3 | revert time-entry to `getByText` | **failed** — strict mode, span + hidden `<option>` |
| NC4 | revert only the `(?!new$)` lookahead | **failed exactly the original 2 tests**, nothing else |
| NC5a/b | point card title / contract filter at wrong targets | **failed** |

NC3 deserves note: resolving that ambiguity *towards* the visible select trigger would have
produced an assertion with **no signal** — the trigger shows what was typed and stays visible even
if `createContract` fails outright. Targeting the created row restores lost signal rather than
silencing strict mode.

## Four more defects the earlier failures were masking

1. **A contract-filter assertion ran against a closed Radix select** — `SelectContent` only mounts
   while open, so the label was nowhere in the DOM.
2. **`getByRole("heading", {name:"Response"})` could never have matched** — `CardTitle` renders a
   plain `<div>` without `asChild`.
3. **A 65s wait inside a 30s test budget** — `time-entry-to-invoice` was structurally unable to
   pass. `test.setTimeout(180_000)` added, with a comment stating it is not flake padding.
4. **The spec poisoned itself.** `TimeEntry_one_active_timer_per_user` allows one open entry per
   user, so a run dying between Start and Stop stranded one and made *every later run* fail at a
   different assertion. An `afterEach` now closes open entries for the seeded technician only.

## A flake found by not trusting one green run

After everything above the suite went green — then the agent ran it repeatedly rather than
reporting the first pass. **2 red in 8 full-suite runs (25%).**

Root cause: `await expect(page.getByRole("alert")).toHaveCount(0)` was documented as "wait for its
own success signal". **A negative assertion that is already true is satisfied on its first
evaluation — it waited for nothing.** `assignTicket` was still in flight when `page.goto()` fired.
Database arbitration: all 15 assign tickets had `assignedToId` populated **including the failing
runs'** — the write always landed, the test read too early. Replaced with `page.waitForResponse` on
the Server Action POST.

**Honest limit**: reverting the old guard and running `--repeat-each=12` in isolation passed 12/12 —
the race needs full-suite contention, so it was not reproduced under a controlled revert. Evidence
is the mechanism, the database, and 10 consecutive green runs after vs 6-green/2-red before.
P(10 green | 25% failure) ≈ 5.6% — strong, not proof.

## Task 4 — measured, not asserted

- **Before**, 09-03's exact command: `0` — reproduced.
- `test:e2e` now `--project=lifecycle --project=advisory --project=last-active-admin`.
- **After**, through the real script: `npm run test:e2e -- --list | grep -c tickets.spec.ts` → **6**,
  of which **3 match `delete`**. Gate total **45 → 53**.

**The plan predicted 3; the true answer is 6** — `tickets.spec.ts` holds six tests. The agent
reported the measurement rather than massaging it toward the prediction. Coordinator confirmed: 6
and 3.

## Verification

- `npm run test:e2e:advisory` → **exit 0, 8 passed**. Was exit 1, 4 passed / 4 failed.
- `npm run test:e2e` → **exit 0, 53 passed**, ×3 by the agent, re-run by the coordinator.
- `npx tsc --noEmit` → exit 0 *(regression guard)*.
- `npm run lint` → exit 0. **Not vacuous here**: it caught `react-hooks/rules-of-hooks` firing on
  Playwright's `use` fixture parameter (read as React 19's `use` hook). Fixed by renaming the
  parameter to `provide`, which Playwright passes positionally — no rule suppressed anywhere.
- Scope check: **Case A** — real dirty tree, 6 paths, `scope ok`; control B → `SCOPE VIOLATION`;
  control C (truly empty tree) → vacuous `scope ok`. The agent's first control C was an artifact of
  its own harness (`echo ""` emits a blank line) and it redid it.
- No symlinks created in `/opt/pw-browsers/` — 0 in both `-1234` trees.

## Three defects in this plan, found by the agent executing it

All three were the coordinator's:

1. **Task 4's `<verify>` hardcoded the OLD project list**, so it measured a stale definition and
   would still return `0` after a correct fix. Now asks the real script.
2. **It predicted `3` where the answer is `6`.** Corrected, with a note to report the measurement.
3. **The `<verification>` scope regex omitted `package.json`** — which the plan's own `files_owned`
   includes and task 4 *requires* changing — so it reported `SCOPE VIOLATION` on a correct tree.

## Issues — recorded, not fixed

1. **`DEPLOYMENT.md` advisory passage was false on two counts.** The agent declined to edit it:
   absent from `files_owned` and from its brief, and its instruction on a scope conflict is to
   report rather than guess. **Correct call.** Fixed by the coordinator.
2. **Accessibility, in `src/`**: the SLA report's "Response"/"Resolution" titles are
   `<div data-slot="card-title">` with no heading role, so the report has no navigable structure
   below its `<h1>`. `CardTitle` supports `asChild` for exactly this.
3. **Gate runtime doubled**, 1.2m → 2.4m, dominated by `time-entry-to-invoice`'s unavoidable 65s
   real-elapsed timer wait. Acceptable; the obvious target if gate latency ever matters.
