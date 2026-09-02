# 07-07 Summary — Integration gate and E2E

**Status**: Complete
**Wave**: 4
**Agent**: testing-qa-verification-specialist
**Date**: 2026-09-02

## Files changed

- `e2e/user-lifecycle.spec.ts` — new, 13 tests, tagged `@user-lifecycle`
- `e2e/fixtures.ts` — added `loginWith` and `loginExpectingFailure`; `loginAs` untouched
- `src/app/(auth)/change-password/actions.ts` — the reconciliation import

A transient diagnostic probe (`e2e/zz-probe.spec.ts`) was created, used and deleted — confirmed absent.

## Environment note

The orchestrator stopped `dean-psa-app-1` before this plan ran. `playwright.config.ts:26` sets
`reuseExistingServer: !process.env.CI`, so with that container up Playwright would have silently
reused a 10-hour-old image containing none of Phase 7 — producing results that looked real and
meant nothing. `baseURL` and `webServer.url` are both hardcoded with no env override, and
`playwright.config.ts` is in no plan's `files_modified`, so freeing the port was the only honest
option. The container was restarted afterwards. **Neither critique round caught this.**

## Blocking gate

| Command | Result |
|---|---|
| `npx prisma generate` | exit 0 |
| `npx tsc --noEmit` | **exit 0** |
| `npm run lint` | exit 0 — 0 errors, 1 pre-existing warning (`e2e/sla-tracking.spec.ts:48`, untouched) |
| `npm run test:e2e -- --grep @user-lifecycle` | **13 passed (25.1s)**, exit 0 |

Three consecutive green runs before the final one, under `--workers=1`, the default 2, and inside
the full parallel suite. **Independently re-run by the orchestrator: 13 passed, exit 0.**

## Advisory full-suite run — referred to Phase 9

```
14 passed, 4 failed, 2 skipped (52.9s)
```

All four failures are pre-existing and none is a Phase 7 regression. Baseline before this spec
existed was 0 passed / 5 failed / 2 skipped; the delta is a flake, not a change.

1. `sla-tracking.spec.ts:33` — strict-mode violation: `getByText(subject)` matches both the `<h1>`
   and Next's `__next-route-announcer__`.
2. `tickets.spec.ts:112` — `getByText("in progress", {exact:true})` not found after the dnd-kit drag.
3. `tickets.spec.ts:191` — `getByText("Technician Test User")` resolves to a *hidden* `<option>` in
   Radix's bubble select.
4. `time-entry-to-invoice.spec.ts:61` — `getByText("Hourly Break-Fix")` matches both the Radix
   `select-value` span and the hidden `<option>`.

Also for Phase 9: **`tickets.spec.ts:72` is flaky** — 30s timeout in the baseline, passing later.
The 2 skipped are the pre-existing `test.fixme` delete tests Phase 9 owns.

## Coverage

Every plan bullet plus the four the critique added, all automated: create with once-shown temp
password; forced redirect to `/change-password`; dashboard routes unreachable while flagged;
landing on `/` after setting a password and surviving a reload; role change effective on the next
request **without re-login**; deactivation effective on the next request; re-login refused with the
*same* message as a wrong password; **mixed-case email normalization**; **deactivate → reactivate →
log in**; **admin-only gating** (technician sees no link *and* is refused at the URL); **three
self-target refusals**.

One test added beyond the plan: the *successful* `resetUserPassword` path was untested — it now
asserts a new value is issued, the old password stops working, and the user is forced back through
`/change-password`.

Two mechanics established by probe rather than assumption:

- **The self-target proof is real, not cosmetic.** 07-05 disables those controls client-side, and
  removing the DOM `disabled` attribute is *not* enough — React suppresses `onClick` when the fiber
  props carry `disabled: true`. The spec invokes the handler off `__reactProps$` and asserts the
  **server** refuses and the row is unchanged in the database.
- **"No re-login" is proven by decoding the live session cookie**: the JWT still says
  `role: "technician"` while the request is authorized as admin. A first attempt comparing raw
  cookie values was wrong — Auth.js re-encrypts the JWE every response.

Not E2E-observable: `getCurrentUser()` doing exactly *one indexed lookup* remains 07-02 inspection.

## Manual evidence

**Last-active-admin guard rail — reachable only under concurrency.** Against the live database:

```
admins: [{ admin@mspdemo.local, isActive: true }]
countOtherActiveAdmins(excluding actor) = 0  -> LAST_ADMIN_ERROR would fire: true
```

`requireRole` guarantees the actor is an active admin and the self-target check runs *before* the
transaction, so the actor always counts toward the total. Single-threaded the branch is
unsatisfiable; it becomes reachable only when the actor is deactivated or demoted concurrently —
which is exactly what 07-03's advisory lock exists for.

**Concurrency invariant — two admins deactivating each other, three consecutive runs, identical:**

```
BEFORE  activeAdmins=3
CLICK RESULTS ["fulfilled","fulfilled"]
A targeting B: url=/admin/users    error="(none)"
B targeting A: url=/unauthorized   error="(none)"
AFTER   activeAdmins=2   (B INACTIVE)
```

Exactly one deactivation commits. The loser is stopped by `getCurrentUser()`'s freshness check
inside its own `requireRole` — deactivated mid-action and redirected. **This is 07-02's revocation
observed end-to-end through HTTP**, not at the SQL layer.

**`bootstrap:admin` on a fresh database — not re-run.** Creating a probe database was denied by the
sandbox and the only alternative was mutating the shared dev database. Verified on the merged tree:
`--help` exits 0, and a password as a second argument is refused with exit 1. 07-06's pty
transcript stands as the fresh-database evidence.

## Password reconciliation

`change-password/actions.ts` now imports `MIN_PASSWORD_LENGTH` from `src/lib/validations/user.ts`;
07-04's local `const` is gone. Both were 12, so no behavioural change. Every **server-side**
enforcement point now reads one definition.

**Left deliberately**: `change-password-form.tsx:19` keeps a literal `12` for the hint text and
native `minLength`. It is outside this plan's write targets, and `actions.ts` is `"use server"` so
it cannot re-export the constant for a client import. Documented at the import site.

## Findings referred to other plans

1. **The rate limiter makes the app unusable for a real team — Phase 8.** Measured: 60 consecutive
   requests to `/unauthorized` returned 307; requests 61–75 returned **429**. `getClientIp()` falls
   back to the literal key `"unknown"` when no `X-Forwarded-For`/`X-Real-IP` is present, and
   `docker-compose.yml` ships no reverse proxy — so **every user in the deployment shares one
   60-request-per-minute budget**. A 429 on a Server Action POST surfaces as *"Something went
   wrong. Please try again."* This is a launch-readiness problem, not a test problem.
2. **07-03/07-05** — the last-active-admin branch is unreachable except under concurrency (above).
   Not a defect; but `LAST_ADMIN_ERROR` can never be seen by a single admin acting alone, and the
   advisory lock is load-bearing rather than defensive.
3. **07-05** — the three self-target refusals are unreachable through the shipped UI because the
   controls are disabled. Correct defence-in-depth, but the plan's expectation that they "show a
   visible error" does not match what ships.
4. **07-05** — intermittent hydration mismatch on the self-row `AlertDialogTrigger`
   (`disabled={true}` server vs `disabled={null}` client via Radix `asChild` Slot prop-merging).
   Seen once in five runs, dev mode only.
5. **Pre-existing accessibility** — `ui/card.tsx`'s `CardTitle` renders a `<div>`, so
   `/change-password` and `/unauthorized` have **no heading element at all**.
6. **`DEPLOYMENT.md` is accurate** — all six `/admin/users` references resolve to a route that
   exists and is admin-only gated. 07-06's risk #3 checks out and is now covered by an assertion.

## Auto-remediation

None on the product. Four corrections to the agent's own spec, each driven by a measurement rather
than a guess: the `getByRole("heading")` assumption (CardTitle is a div), the cookie-identity
assumption (Auth.js re-encrypts), `getByRole("alert")` matching Next's empty route announcer, and
the DOM-`disabled` bypass (React's fiber-props guard).

## Risks

- The self-target test depends on React's `__reactProps$`. It fails loudly with a named message if
  that internal moves; do not delete the assertions it guards.
- The spec sends a per-context `X-Forwarded-For` to get its own rate-limit bucket. If finding 1 is
  fixed by adding a trusted proxy, revisit — the header would then be overwritten and the
  shared-bucket problem returns for the suite.
- Teardown is a direct Prisma `deleteMany` on the exact addresses created. Verified by the
  orchestrator after the run: the database holds exactly the five `@mspdemo.local` fixtures, all
  active and unflagged. It relies on subjects owning no tickets/comments/time entries — true today,
  and it fails loudly on a foreign key rather than silently if that changes.
