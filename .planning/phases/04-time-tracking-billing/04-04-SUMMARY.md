# Plan 04-04 Summary: QuickBooks OAuth Connection Scaffolding

## Result
**Status**: Complete
**Wave**: 2
**Agent**: engineering-backend-architect
**Completed**: 2026-09-01T02:29:30Z

## Completed Tasks
1. Created `src/lib/qbo.ts` -- fetch-based OAuth2 client exporting `exchangeCodeForTokens`, `refreshAccessToken`, `getValidQboClient`, and `buildAuthorizeUrl`. No SDK dependency; uses plain `fetch` against Intuit's token/authorize endpoints.
2. Created `src/app/api/qbo/connect/route.ts` and `src/app/api/qbo/callback/route.ts` -- CSRF-protected authorization-code OAuth2 flow. Both use `getCurrentUser()` + `can()` (connect route) rather than `requireRole()`, per the plan's explicit mandate that `requireRole()` is unsafe to call from a Route Handler.
3. Created `src/lib/actions/qbo-connection.ts` (`disconnectQbo`, `setCompanyQboCustomerId`, both gated by `requireRole(QBO_MANAGE_ROLES)`), the admin page `src/app/(dashboard)/admin/quickbooks/page.tsx`, updated the sidebar's Admin `<li>` to link to `/admin/quickbooks` when permitted, and appended 4 QBO env vars to `.env.example`.

## Files Modified
- `src/lib/qbo.ts` (new) -- OAuth2 token exchange/refresh + lazy-refreshing `getValidQboClient()` helper, all via plain `fetch`.
- `src/app/api/qbo/connect/route.ts` (new) -- `GET` handler: manual `getCurrentUser()`/`can()` gate, generates CSRF `state`, sets short-lived httpOnly cookie, redirects to Intuit's authorize URL. Exports `QBO_OAUTH_STATE_COOKIE` for the callback route to reuse.
- `src/app/api/qbo/callback/route.ts` (new) -- `GET` handler: handles `error` query param, validates `state` against the cookie, exchanges the code for tokens, deletes any existing `QuickBooksConnection` row and creates a fresh one (guarantees at most one row), redirects to `/admin/quickbooks` with a success/error indicator.
- `src/lib/actions/qbo-connection.ts` (new) -- `"use server"` actions `disconnectQbo` and `setCompanyQboCustomerId`, both `requireRole(QBO_MANAGE_ROLES)`-gated, with P2025 handling and `revalidatePath("/admin/quickbooks")`.
- `src/app/(dashboard)/admin/quickbooks/page.tsx` (new) -- async Server Component gated by `can(user.role, "qbo:manage")`; shows connection status/realmId, Connect/Disconnect affordances, and a per-company `qboCustomerId` inline-edit form (bound Server Action per row, no client component needed).
- `src/components/nav/app-sidebar.tsx` (modified, Admin `<li>` block only) -- now renders a real `Link` to `/admin/quickbooks` when `can(role, "qbo:manage") || can(role, "admin:manage_users")`, otherwise keeps the original disabled "(Coming soon)" placeholder.
- `.env.example` (modified, append only) -- added `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENVIRONMENT`, `QBO_REDIRECT_URI` with per-var comments matching the existing style.

## Verification Results
- `npx tsc --noEmit` initially surfaced one new error in the admin page (form `action` prop typed to return `void | Promise<void>`, but `disconnectQbo`/inline closure returned `Promise<{success:true}>`); fixed by wrapping the call in a local `async () => { "use server"; await disconnectQbo(); }` closure that returns `Promise<void>`. Second run: only the documented pre-existing `src/app/layout.tsx(20,50): error TS2304: Cannot find name 'LayoutProps'` remains.
- `git diff --stat` confirms exactly `.env.example` and `src/components/nav/app-sidebar.tsx` were modified among files outside my write targets' new-file set (other modified/untracked files in the worktree belong to the concurrently-executing Plan 04-03 agent, as expected).
- `git diff src/components/nav/app-sidebar.tsx` confirms only the Admin `<li>` block changed -- no other part of the file was touched.
- `package.json`/`package-lock.json`: no diff.

## Verification Commands
| Command | Exit Code | Result |
|---------|-----------|--------|
| `test -f src/lib/qbo.ts` | 0 | pass |
| `grep -q 'export async function exchangeCodeForTokens' src/lib/qbo.ts` | 0 | pass |
| `grep -q 'export async function refreshAccessToken' src/lib/qbo.ts` | 0 | pass |
| `grep -q 'export async function getValidQboClient' src/lib/qbo.ts` | 0 | pass |
| `grep -q 'export function buildAuthorizeUrl' src/lib/qbo.ts` | 0 | pass |
| `test -f 'src/app/api/qbo/connect/route.ts'` | 0 | pass |
| `grep -q 'export async function GET' 'src/app/api/qbo/connect/route.ts'` | 0 | pass |
| `grep -q 'getCurrentUser' 'src/app/api/qbo/connect/route.ts'` | 0 | pass |
| `test -f 'src/app/api/qbo/callback/route.ts'` | 0 | pass |
| `grep -q 'export async function GET' 'src/app/api/qbo/callback/route.ts'` | 0 | pass |
| `test -f src/lib/actions/qbo-connection.ts` | 0 | pass |
| `grep -q 'requireRole(QBO_MANAGE_ROLES)' src/lib/actions/qbo-connection.ts` | 0 | pass |
| `test -f 'src/app/(dashboard)/admin/quickbooks/page.tsx'` | 0 | pass |
| `grep -q 'qbo:manage' 'src/app/(dashboard)/admin/quickbooks/page.tsx'` | 0 | pass |
| `grep -q 'QBO_CLIENT_ID' .env.example` | 0 | pass |
| `npx tsc --noEmit` | 2 (only pre-existing layout.tsx LayoutProps error) | pass (documented exception) |

## Key Decisions
- **`exchangeCodeForTokens` `realmId` field**: Intuit's OAuth2 token endpoint response does not include `realmId` -- it is only delivered as a separate query parameter on the callback redirect URL. `exchangeCodeForTokens` returns `realmId: ""` to satisfy the required return-type shape from the plan, and the callback route (`src/app/api/qbo/callback/route.ts`) merges in the real `realmId` from `url.searchParams.get("realmId")` when constructing the `QuickBooksConnection` row. This preserves the exact function signature the plan specified while keeping the actually-correct value flow.
- **Endpoint URLs**: kept the plan's best-effort URLs as-is (`https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer` for token exchange/refresh, `https://appcenter.intuit.com/connect/oauth2` for authorization) -- these match Intuit's long-standing publicly documented OAuth2 endpoints from prior knowledge; no live web verification was performed in this environment, so they should still be smoke-tested against a real Intuit sandbox app before production use.
- **CSRF state cookie**: implemented as an httpOnly, `sameSite: lax`, 5-minute-`maxAge` cookie set via `NextResponse.cookies.set` in the connect route, read via `next/headers`'s `cookies()` in the callback route (no existing cookie-handling convention existed elsewhere in the codebase to match, so this uses Next.js's standard Route Handler cookie APIs). Cookie is deleted on every callback code path (success, state mismatch, missing params, token exchange failure, and Intuit-side `error`).
- **Single-row invariant**: the callback route uses `deleteMany({})` followed by `create()` (rather than a fixed well-known id + upsert) to guarantee at most one `QuickBooksConnection` row ever exists, matching the plan's "your choice" allowance.
- **Admin page interactivity without new client components**: the "Disconnect" button and per-company `qboCustomerId` inputs are wired via native `<form action={...}>` bindings to Server Actions (including a per-row bound inline Server Action closure for `setCompanyQboCustomerId`), avoiding the need for a new client component file that wasn't in this plan's write-target list.
- **Sidebar gating**: implemented the inner check exactly as specified (`can(role, "qbo:manage") || can(role, "admin:manage_users")`) even though it is nested inside an outer gate of `can(role, "admin:manage_users")`, making the inner check currently always-true given the present role/permission matrix. This is a literal, non-restructuring implementation per the plan's explicit "only change it to link out instead of being disabled" instruction and the forbidden-action against restructuring the rest of the file.

## Issues Encountered
One tsc error surfaced during Task 3 verification (form `action` prop type mismatch on the Disconnect button) -- fixed by wrapping `disconnectQbo()` in a `Promise<void>`-returning inline Server Action closure. No other issues. No forbidden files were touched; no new dependencies were added.

## Requirements Covered
- Accounting integration (QuickBooks or Xero) for pushing invoices
