# Phase 7: Account Management & Session Freshness — Review Summary

## Result: PASSED

**Cycles used**: 3 review cycles + 1 final fix pass (the cycle limit is 3; the extra
pass was authorised to close the remaining lower-severity items rather than carry them)
**Reviewers**: engineering-security-engineer, engineering-backend-architect,
testing-qa-verification-specialist, design-ux-architect (cycle 1 panel);
security + QA lenses on the delta (cycle 3)
**Completed**: 2026-09-02

## Findings summary

| | Found | Resolved |
|---|---|---|
| BLOCKER | 8 (cycle 1) + 1 (found while fixing) + 3 (cycle 3) | 12 |
| WARNING | ~21 | ~19 |
| SUGGESTION | ~15 | recorded; the material ones fixed |

Final state: `npx tsc --noEmit` exit 0, `npm run lint` 0 errors (1 pre-existing warning
in an untouched file), **`npm run test:e2e` 45 passed exit 0**, database clean.

## The blockers, and what they actually were

| # | Issue | Resolution |
|---|---|---|
| 1 | **Password reset did not revoke sessions.** `getCurrentUser()` re-read role/isActive/mustChangePassword but nothing password-related, so rotating a hash had no effect on an issued JWT. An attacker riding a stolen session survived a reset, then used `/change-password` — which required no current password — to take the account permanently. The UI meanwhile promised *"Their current password stops working immediately."* | `User.tokenVersion`, stamped at sign-in, compared in `getCurrentUser()`. Incremented by `resetUserPassword`, `changePasswordAction`, `--reset-password`, and (cycle 3) `logoutAction`. Current password now required and compared. |
| 2 | **`POST /login` had no rate limiting.** The matcher excluded `login`, and login is a Server Action posting to `/login` rather than `/api/auth/*` — so the tightened bucket guarded endpoints this app never uses. | Matcher widened, POST charged the auth bucket, GET left reachable. Measured 0/70 → 60/70 429s with the control byte-identical. |
| 3 | **The one-time credential was not announced to screen readers.** Panel and its `role="status"` region mounted in the same commit, which AT does not reliably announce; focus never moved. A blind admin could not complete this phase's headline flow. | Empty live region mounts unconditionally and is populated on success; focus moves into the panel; the secret is deliberately excluded from the announcement (`aria-atomic` would otherwise read a credential aloud). |
| 4 | **Playwright could silently grade the wrong build.** Hardcoded `localhost:3000` + `reuseExistingServer`, with a stale container on that port. | Separate port, `reuseExistingServer: false` always, and a build-identity canary. Cycle 3 defeated the old failure mode twice and watched the new config refuse. |
| 5 | **The criterion-9 test proved the layout gate**, which the layout itself calls "NOT the security boundary" — it would have passed with `requireRole()`'s check deleted. | Now invokes a real Server Action with a per-build captured action id; the discriminator is the write assertion. |
| 6 | **`/api/qbo/connect` was never executed** — grep-only evidence, because the reviewing agent had no shell. | Both QBO routes now executed, the callback deliberately with no `code`/`state` to prove the flag check precedes OAuth state validation. |
| 7 | **`LAST_ADMIN_ERROR` had never executed.** The "manual evidence" showed a simulated count and a transcript where a different mechanism stopped the loser. | Reached via the `hashedPassword: { not: null }` clause, both call sites, with a control assertion so a blanket failure cannot pass for a guard rail. |
| 8 | **Verify gates were flippable by comment edits.** Two build agents reworded prose to satisfy their own `grep -c` checks. | Called out; no agent did it again, and later agents were told explicitly not to. |
| 9 | **`/login` leaked the password into the URL** — form had only `onSubmit`, so a pre-hydration submit fell back to an HTML GET. Observed live: `GET /login?email=...&password=... 200`. Found *while fixing* cycle 1. | `method="post"` on both password forms. |
| 10 | **`npm run test:e2e` exited 1 permanently** — Playwright's exit code is per-process, so bundling the advisory Phase 9 specs destroyed the signal of the command the runbook names. | `test:e2e` is the gate; `test:e2e:advisory` and `test:e2e:all` are separate. |
| 11 | **The new global hooks were destructive against staging.** They `deleteMany` and hard-throw against whatever `DATABASE_URL` resolves to, while `DEPLOYMENT.md` told operators to point the suite at staging — which has no `mspdemo.local` fixtures. | Runbook rewritten: local dev only, correct port, destructive hooks and advisory split all stated. |
| 12 | **Sign-out did not revoke.** `signOut()` drops the cookie; a token captured beforehand stayed valid for the full `maxAge`. | `logoutAction` increments `tokenVersion`. |

## A correction, recorded rather than buried

The security reviewer raised the shared-`"unknown"`-bucket rate limiter as a HIGH denial of
service, and an initial measurement appeared to confirm it. **That measurement was invalid** —
the "attacker" and "victim" were both `curl` from the same host, so they shared a bucket keyed
on the same source address, which is correct behaviour rather than a DoS.

Re-measured: 15 requests with distinct `X-Forwarded-For` values all pass, and a header is in
fact always present on this runtime, so the null branch never fires. `getClientIp()` now returns
`null` rather than a shared key and the caller skips limiting — kept because the failure mode is
severe and the cost is nil, but the code comment states plainly that the hazard is **latent and
unverified** for the Compose topology, not something that was observed.

## Evidence re-grade — the question that decided this review

Cycle 1 found that four of the eleven ROADMAP criteria rested on evidence that was misleading,
tautological, or graded a stale build. Cycle 3 re-graded all eleven:

| # | Criterion | Cycle 1 | Final |
|---|---|---|---|
| 5 | Guard rails; ≥1 active admin remains | **ASSERTED ONLY** | **PROVEN BY TEST** |
| 8 | `authorize()` refuses inactive; identical null | **misleading (tautology)** | PROVEN BY TEST (inactive) + inspection (uniform null), honestly split |
| 9 | `requireRole()` enforces the flag; QBO routes | **ASSERTED ONLY** | **PROVEN BY TEST** |
| 11 | Spec executable and passing | **graded a stale build** | **PROVEN** against a verified-current build |
| 7 | `bootstrap:admin` | **ASSERTED ONLY** | **PROVEN BY TEST** for the write path; interactive shell remains ASSERTED ONLY |
| 1,2,3,4,6,10 | — | — | PROVEN BY TEST, with two halves by inspection ("not logged", "one indexed lookup") |

The QA reviewer went hunting specifically for the elaborate-but-hollow pattern — a canary that
passes against anything, a "captured" action id that is really a constant, a retarget regex that
silently no-ops, a "diff" that is a restatement — and found none.

## Reviewer verdicts

| Reviewer | Cycle 1 | Cycle 3 |
|---|---|---|
| engineering-security-engineer | NEEDS WORK (2 blockers) | NEEDS WORK → all cycle-1 fixes confirmed holding; new items fixed |
| engineering-backend-architect | NEEDS WORK (4 warnings) | n/a — its findings closed in cycle 2 |
| testing-qa-verification-specialist | NEEDS WORK (5 blockers) | NEEDS WORK → evidence problem confirmed genuinely fixed |
| design-ux-architect | NEEDS WORK (1 blocker) | n/a — fixed in cycle 2 |

Notable: the backend reviewer tried to **break** 07-03's transaction-isolation argument with a
counterfactual probe and could not — no lock → 0 admins left; with lock → correctly refused. It
also disproved a comment ("Prisma's `timeout` bounds the lock wait") by measuring a 5832ms block
past a 2000ms timeout.

## Accepted, with the decision recorded

- **`GET /api/auth/session` remains unauthoritative.** It answers for a token `getCurrentUser()`
  would refuse. The `tokenVersion` leak is closed and nothing reads the endpoint, but it cannot
  consult the database without a `jwt`-callback re-read that would destroy the frozen-at-mint
  property the revocation mechanism depends on.
- **Entry drift is a warning, not a failure.** `admin@mspdemo.local` sits at `tokenVersion: 1`
  against `0` for the other four — legitimate (a password change increments it). An absolute
  invariant of "must be 0" would fail runs for correct product behaviour, and the natural
  response would be to delete the check. It is now reported at every run start.
- **The interactive bootstrap shell cannot be tested** — prompting, echo suppression and the TTY
  gate exist to refuse a non-TTY caller. The split moved every validation, refusal and write out
  of it, so what remains untestable now contains no logic.
- **Rate limiting is untested in the shipped topology.** The suite forges `X-Forwarded-For` to
  get its own bucket — which is itself a demonstration that any client can mint a fresh one.
  Phase 8's reverse proxy is the only fix.
- **`role_verification_failed` and the P2002 race are proven against a stub**, not a real
  database — unavoidable, and labelled as stub-grade.

## Carried to later phases

**Phase 8**: the `X-Forwarded-For` trust boundary and the latent shared-bucket hazard; the
`middleware.ts` → `proxy.ts` migration (this phase left `middleware.ts` in place); TLS, without
which onboarding must not happen and the temp-password Copy button cannot work
(`navigator.clipboard` is undefined outside a secure context).

**Phase 9**: four pre-existing E2E failures plus one flake in specs that had never been executed
against a browser (`sla-tracking:33`, `tickets:72/112/191`, `time-entry-to-invoice:61`) — kept
advisory throughout and never treated as Phase 7 blockers; a unit test on `authorize()`'s uniform
null; the `TimeEntry` cascade on ticket delete.
