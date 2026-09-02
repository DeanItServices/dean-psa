# 07-04 Summary — Change-password route

**Status**: Complete
**Wave**: 2
**Agent**: engineering-frontend-developer
**Date**: 2026-09-02

## What was done

| File | Change |
|------|--------|
| `src/app/(auth)/change-password/page.tsx` | **New.** Server Component — resolves the session, `redirect("/login")` when absent, renders the form in a Card. |
| `src/app/(auth)/change-password/change-password-form.tsx` | **New.** `"use client"` form (new password + confirmation), surfaces `{ error }` inline, `router.push("/")` + `refresh()` on success. |
| `src/app/(auth)/change-password/actions.ts` | **New.** `changePasswordAction` — resolves the caller via `getCurrentUser()`, validates, hashes at bcrypt cost 10, writes `hashedPassword` + `mustChangePassword: false` in one `db.user.update`. |

Three files, not two, because `"use client"` is file-scoped: a page that both checks the session
server-side and holds form state cannot be one file.

## The parallelism constraint proved load-bearing

The plan forbade `requireRole()` in this route and required `getCurrentUser()` instead. That was
not theoretical caution — 07-02 landed its change *during this agent's execution*, and
`requireRole()` at `src/lib/session.ts` now redirects on `mustChangePassword`, which is exactly
the state every caller of this page is in. Had the action used it, every password submission would
have bounced the page into itself.

The agent verified `requireRole` appears nowhere in the route, including transitively: the four
`@/components/ui/*` modules it imports contain no `lib/session` or `@/auth` reference.

## Loop-prevention confirmed

It re-read `src/app/(auth)/layout.tsx` at the end of execution and quoted it — a plain
centered-card wrapper, no `getCurrentUser`, no `auth()`, no `redirect`. It also checked 07-02's
`(dashboard)/layout.tsx` diff and confirmed the redirect there is a plain
`if (user.mustChangePassword) redirect("/change-password")` with **no special-casing of the
route** — so route-group placement remains the sole mechanism, as designed. The two halves agree.

## Verification

Agent-run and **independently re-run by the orchestrator** against the merged tree:

| Check | Result |
|---|---|
| `npx tsc --noEmit` (baseline, pre-edit) | exit 0 — the passing final typecheck is earned, not inherited |
| `npx tsc --noEmit` (final, merged) | exit 0 |
| `npm run lint` | 0 errors |
| `grep -c 'requireRole'` in the route | **0** |
| `test ! -d 'src/app/(dashboard)/change-password'` | passes — nothing under `(dashboard)` |
| `grep -rnE "console\.|logger"` in the route | none — nothing logged |
| local `MIN_PASSWORD_LENGTH` | `12` in both files, matching 07-03's landed `12` |

The final typecheck ran against the tree *including* 07-02's rewritten `getCurrentUser()` and
07-03's new validations module, so this route is verified compatible with both rather than only
with the pre-wave state.

## Auto-remediation

One, self-caught. The agent's first draft of `actions.ts` explained the design in a comment that
*named* `requireRole()` twice. Factually correct, but it fails the plan's own verify line
`test "$(grep -c 'requireRole' …)" = "0"` — a check that exists precisely so the identifier can
never appear. It rewrote the comment to describe "the role-gate helper alongside it in
`src/lib/session.ts`", preserving the rationale. Caught by running the verify block, not by
inspection.

## Decisions

- **Validation**, all server-side and authoritative: no session → session-expired message; empty →
  "Enter a new password."; `< 12` → length message; mismatch → "Passwords do not match." Reuse of
  the temporary password is allowed, per the plan. The current/temp password is not requested
  anywhere.
- **Action signature** is `(newPassword, confirmPassword) => Promise<{ error: string | null }>` —
  plain arguments returning `{ error }`, matching `login/actions.ts` rather than the `FormData`
  style, for consistency inside the route group. `MIN_PASSWORD_LENGTH` is deliberately not
  exported from the `"use server"` file (value exports there would be rejected).
- **The `12` is duplicated into the form file** to drive the hint text and native `minLength`; the
  server remains authoritative. Judged worth one more literal that 07-07 collapses anyway.
- **No `revalidatePath`**, unlike the `src/lib/actions/**` convention — both layouts involved are
  dynamic per-request and `router.refresh()` handles the client router cache, the same pattern the
  login flow already uses.
- **Accessibility**: `<Label htmlFor>`, `autoComplete="new-password"`, `aria-describedby` on the
  hint, `role="alert"` on the error, submit disabled in flight.

## Risks and follow-ups

1. **Not exercised at runtime** — typecheck, lint and static structure only. No app boot, no
   browser. 07-07's `@user-lifecycle` spec is this route's first real execution. The agent named
   this as its own largest residual gap.
2. **`getCurrentUser()` now fails closed by throwing** (07-02's deliberate choice) rather than
   returning null on a database error. This page calls it outside any try/catch, so an outage
   surfaces as an error boundary rather than a `/login` redirect — correct per 07-02's semantics,
   but it means the page is unreachable during an outage.
3. **No rate limiting or strength check beyond length** — out of scope; the 12-character floor with
   no composition rules is the phase's pinned decision.
4. **The literal `12` exists in three places** until 07-07 reconciles. All three currently agree;
   the agent verified the third by reading 07-03's file rather than assuming.
