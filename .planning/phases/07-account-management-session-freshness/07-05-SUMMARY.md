# 07-05 Summary — Admin users UI

**Status**: Complete
**Wave**: 3
**Agent**: engineering-frontend-developer
**Date**: 2026-09-02

## What was done

| File | State |
|---|---|
| `src/app/(dashboard)/admin/users/page.tsx` | new — Server Component gated with `requireRole(ADMIN_MANAGE_ROLES)` |
| `src/components/admin/user-create-form.tsx` | new — client |
| `src/components/admin/user-row-actions.tsx` | new — client |
| `src/components/ui/alert-dialog.tsx` | new — the one permitted `ui/` addition |
| `src/components/nav/app-sidebar.tsx` | modified — the `<li>` restructured into a real section |

## The sidebar restructure

Before: one `<li>` gated on `admin:manage_users`, containing a ternary whose true-branch rendered
a single link labelled **"Admin"** → `/admin/quickbooks`, and whose else-branch was unreachable.

After: an `<h2>` heading over a nested `<ul>` with two separately-gated, separately-labelled
links — "QuickBooks" (`can(role,"qbo:manage")`) and "Users" (`can(role,"admin:manage_users")`).
`aria-labelledby` associates the section name with its list programmatically.

**The dead else-branch was deleted.** Its condition could never be false inside a block already
gated on the same permission, and it advertised a "(Coming soon)" state that no longer exists.
That made the `cn` import unused, so it was removed too — otherwise lint would have failed on
`no-unused-vars`.

The two guards were deliberately **not** collapsed onto the outer one. `/admin/quickbooks/page.tsx:56`
checks `qbo:manage`; `/admin/users` checks `admin:manage_users`. Identical today, so a single guard
would be indistinguishable — until either permission is widened, at which point the nav would
advertise a page that refuses the visitor. The reasoning is recorded in a comment above the block.

## A real typing finding

The plan's prose assumed `"error" in result` would narrow 07-03's action return types. **It does
not.** TypeScript normalizes a function's multi-return object literals so every member declares
every key — the failure member carries `success?: undefined`, the success member `error?: undefined`
— so `in` matches every member and narrows nothing. `result.error` alone does not narrow either,
because `string` is not a unit type and therefore not a discriminant.

The agent probed this with a throwaway `tsc` file rather than assuming, then used `if (!result.success)`
where it needed values off the success member (`true | undefined` is two unit types, a genuine
discriminant) and `if (result.error)` where it only needed the message. Both call sites carry a
comment saying why. **This is a consumer-side typing note only — it required no change to 07-03.**

The action signatures actually consumed:

| Action | Signature |
|---|---|
| `createUser` | `(formData: FormData)` → `{success, userId, email, tempPassword}` \| `{error}` |
| `resetUserPassword` | `(id)` → `{success, tempPassword}` \| `{error}` |
| `updateUserRole` | `(id, formData)` → `{success}` \| `{error}` |
| `deactivateUser` / `reactivateUser` | `(id)` → `{success}` \| `{error}` |

Role options come from `ROLE_VALUES` (07-03's client-safe string tuple), and the row component's
`role` prop is typed `(typeof ROLE_VALUES)[number]` rather than Prisma's `Role`, keeping
`@prisma/client` out of the client bundle. Drift fails `tsc` where the page passes `user.role` in.

## The one-time temp password

The returned value goes into ordinary React state and nowhere else — no `localStorage`,
`sessionStorage`, cookie, query parameter, or `router.push`; not logged; not re-derivable from the
server, since only the bcrypt hash was persisted. It survives a re-render of its own component
(the row is keyed by `user.id`, so `revalidatePath` reconciles rather than remounts) but not a
navigation, reload, or Dismiss. The panel says so, and points at Reset password to issue a new one.

**The Copy button will fail over plaintext HTTP**: `navigator.clipboard` is undefined outside a
secure context, and this app runs over HTTP until Phase 8. Rather than a dead button, it catches
that and renders a manual-copy fallback; the value sits in a `<code class="select-all">`.

## The alert-dialog wrapper

`src/components/ui/alert-dialog.tsx` mirrors `dropdown-menu.tsx` point for point: `"use client"`,
the same `import { AlertDialog as AlertDialogPrimitive } from "radix-ui"` namespace-alias form, one
thin function per primitive spreading `React.ComponentProps<typeof …>`, `data-slot` attributes,
`cn()`, and a single flat export block — including that file's no-semicolon shadcn formatting rather
than the semicolon style used elsewhere. `AlertDialogAction`/`AlertDialogCancel` compose
`buttonVariants()` so confirm/cancel match every other button. No `window.confirm` anywhere.

## Verification

Agent-run and **independently re-run by the orchestrator** on the merged tree:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npm run lint` | 0 errors, 1 pre-existing warning (untouched file) |
| `requireRole` in the page | present |
| `window.confirm` occurrences | 0 |
| `localStorage`/`sessionStorage` in `components/admin/` | 0 |
| sidebar contains both `/admin/users` and `/admin/quickbooks` | yes |

Baseline `tsc` was confirmed clean before the agent started, so exit 0 is attributable.

## Decisions

- **Gated with `requireRole(ADMIN_MANAGE_ROLES)`**, deliberately not the QuickBooks page's older
  `getCurrentUser()` + `can()` + manual redirects. That page was the model for layout only. As a
  bonus this inherits 07-02's `mustChangePassword` redirect.
- **Reads via Prisma in the page, writes never.** One `findMany` ordered `isActive desc, email asc`
  so deactivated accounts sink but stay listed. `email` for the secondary sort because `name` is
  nullable. No pagination, no delete control.
- **Deactivated rows stay visible**, dimmed and badged, with Reactivate — the only lifecycle
  control without a confirmation, because it is restorative.
- **Self-target controls are disabled client-side with a stated reason**, but that is UX only.
  Every `{ error }` from 07-03 — the three self-target refusals, last-active-admin, "User not
  found", the duplicate-email message — renders verbatim in a `role="alert"`. Nothing is swallowed.
- **`isNextRedirectError` rethrow in every handler** — `requireRole()` inside these actions
  redirects, and a caught redirect would look like a silently-failed button.
- **No `useEffect` syncing the role select.** The first version had one; `react-hooks/set-state-in-effect`
  failed the lint gate. Removed rather than suppressed.
- **Two comments reworded** because they contained the literal strings `window.confirm()` and
  `localStorage` while *forbidding* them, which made the plan's own verify greps non-zero. Same
  class of self-catch as 07-04's. Prose changed, meaning preserved.

## Risks and follow-ups

1. **No runtime verification.** Allowed Bash was `tsc` and `lint` only — no build, no dev server,
   no browser. Type-checking cannot prove the RSC/client boundary is sound at build time, that the
   Radix portal renders correctly inside a `<TableCell>`, or that any of the five operations work
   end to end. **07-07 owns that gate.**
2. **The Copy button fails over plaintext HTTP** on any non-localhost origin. Graceful fallback,
   but admins hand-copy temp passwords until Phase 8. Relevant to 07-06's runbook wording.
3. **The row actions cell is dense** — select, three or four buttons, error and password panels in
   one `<TableCell>`. It wraps, but a narrow viewport scrolls horizontally. Acceptable for an
   admin-only screen at this user count.
4. **A concurrent revalidation can leave a stale role select** if two admins edit the same user.
   Cosmetic — the submit is still validated server-side against the real row. Documented in the
   component.
