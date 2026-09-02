# 07-02 Summary — Session freshness

**Status**: Complete (agent reported Partial; the one missing verification was performed by the orchestrator — see below)
**Wave**: 2
**Agent**: engineering-security-engineer
**Date**: 2026-09-02

## What was done

The database, not the JWT, is now authoritative for authorization.

| File | Change |
|------|--------|
| `src/lib/session.ts` | `getCurrentUser()` does one `cache()`-wrapped primary-key `findUnique`; inactive or deleted resolves to null. `requireRole()` now also redirects on `mustChangePassword`. Docstrings rewritten. |
| `src/auth.ts` | `authorize()` refuses inactive users on the shared failure path; `maxAge` rationale rewritten (kept at 8h). |
| `src/app/(dashboard)/layout.tsx` | UX-level `/change-password` redirect plus no-loop rationale. |
| `src/app/api/qbo/connect/route.ts` | Its own `mustChangePassword` gate, returning `NextResponse.redirect`. |
| `e2e/fixtures.ts` | Post-login wait now asserts pathname is exactly `/`, failing with a message naming `/change-password`. |

## Dispatch error and its correction

The agent reported **Partial** for an honest reason: the `engineering-security-engineer` registry
entry declares `tools: [Read, Write, Edit, Grep, Glob, WebFetch]` — **no Bash**. Every `<verify>`
block in this plan ends in `npx tsc --noEmit`, which it therefore could not run. It classified
this as ENVIRONMENT, substituted a declaration-level type audit, and explicitly refused to claim
the typecheck passed.

That was an orchestrator dispatch error, not an agent failure. The orchestrator ran the missing
verification against the merged tree: **`npx tsc --noEmit` exits 0**, and `npm run lint` reports
0 errors. The agent's flagged risk — a possible TS2869 on `user.email ?? ""` now that the left
operand is non-nullable — did not materialise.

**Lesson for later waves**: check an agent type's declared tools against the plan's verification
commands before dispatch.

## Verification (orchestrator-run)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npm run lint` | 0 errors, 1 pre-existing warning (`e2e/sla-tracking.spec.ts:48`, untouched file) |
| `authorize()` guard inspected | `if (!user || !user.hashedPassword || !user.isActive) return null;` — single shared path |
| `requireRole()` inspected | `mustChangePassword` redirect present; `/unauthorized` behaviour unchanged |
| `/api/qbo/connect` inspected | `NextResponse.redirect(new URL("/change-password", …))` present |

## Decisions

- **`cache()` wraps the lookup, not `getCurrentUser()`** — `auth()` keeps doing its own cookie/JWT
  work, and every `getCurrentUser()` call in one render shares exactly one query. Request-scoped,
  so zero staleness. No TTL cache, no module-level Map, no `unstable_cache`.
- **Database outage fails closed by propagating, not catching.** Deliberate. Catching and
  returning null would render a total outage as "every user silently logged out" — misleading to
  operators and indistinguishable from genuine deauthentication. Falling back to the JWT's `role`
  was never an option: that restores the staleness bug precisely when the database cannot
  contradict it. Cost: an outage surfaces as an error page rather than a login redirect.
- **P2022 gets the same treatment** — a missing column means 07-01's migration has not reached
  that environment, and it should be loud rather than masquerading as a logout storm.
- **`isActive` checked BEFORE bcrypt, not after.** This closes a timing channel the plan did not
  specify: a deactivated account now skips `compare()` exactly as a nonexistent one does. Checking
  after would have made an inactive account timing-indistinguishable from a *valid* account — the
  wrong equivalence class.
- **`maxAge` kept at 8 hours, with a new rationale.** The old justification ("no server-side
  mechanism to revoke a token early") is now false. The number stays because the database check
  revokes on deactivation and role change but cannot detect theft of a token belonging to an
  account nobody deactivated; 8h bounds that residual case. No user-visible re-login change ships
  with this security fix.

## Risks and follow-ups

1. **Not verified at runtime.** No login as an inactive user, no dev server, no browser. All
   claims are from source and generated declarations. 07-07 owns first real execution.
2. **`/api/qbo/callback/route.ts` was deliberately left alone** — outside `files_modified`. It is
   the OAuth return leg and needs a `qbo_oauth_state` cookie only `/connect` sets, so gating
   `/connect` closes the flow at entry. Flagged rather than silently scope-expanded: if
   belt-and-braces is wanted later, that file needs the identical three-line patch.
3. **A future "already signed in? bounce to /" on the login page would create an infinite loop**
   with this change. Today `src/app/(auth)/login/page.tsx` has no such redirect (verified) and the
   middleware matcher excludes `login`. Worth a comment there someday.
4. **Per-request cost rises by one indexed primary-key read**, shared across the render via
   `cache()`. This is the deliberate price of freshness.
