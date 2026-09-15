# Plan 08-01 — Proxy Migration — SUMMARY

**Status**: Complete
**Wave**: 1
**Agent**: engineering-backend-architect
**Date**: 2026-09-15
**Requirements**: `src/middleware.ts` migrated to `src/proxy.ts`, export renamed to `proxy`, `tsc --noEmit` passes, `authAsMiddleware` cast re-verified rather than copied

## Files

| File | Change |
|------|--------|
| `src/proxy.ts` | **New** (351 lines). Next.js 16 Proxy convention; `export default function proxy(request, event)`. All 303 original lines carried over. |
| `src/middleware.ts` | **Deleted** (renamed by the codemod). |
| `src/auth.config.ts` | **Docstring only.** Edge-runtime *requirement* reframed as a design choice; `src/middleware.ts` reference retargeted. |

Nothing else in the tree changed. `package-lock.json` verified byte-identical.

## Verification

All 20 `> verification:` commands passed; 0 failed. Independently re-run by the coordinator:

```
npx tsc --noEmit                                              -> 0
npm run lint                                                  -> 0
test ! -f src/middleware.ts                                   -> 0
test -f src/proxy.ts                                          -> 0
grep -q 'export default function proxy' src/proxy.ts          -> 0
grep -qF '"/((?!_next/static|_next/image|favicon.ico).*)"'    -> 0
scope: only src/auth.config.ts, src/middleware.ts, src/proxy.ts
```

**Code-only diff vs `HEAD:src/middleware.ts`** (comments stripped) is exactly two hunks —
independently reproduced by the coordinator:

```
-export default function middleware(request: NextRequest, event: NextFetchEvent) {
+export default function proxy(request: NextRequest, event: NextFetchEvent) {
-  ) => ReturnType<import("next/server").NextMiddleware>;
+  ) => ReturnType<import("next/server").NextProxy>;
```

Rate-limit values unchanged at `60_000 / 60 / 10` (`src/proxy.ts:68-70`). Trust-boundary
block **39 lines, identical** — untouched, as 08-04 requires. `src/auth.config.ts` has zero
non-comment changes. No `@ts-expect-error`, no `any`.

## Doc verification (this install, `next@16.3.3`)

The claim the whole phase ordering rests on, confirmed verbatim:

- `.../03-file-conventions/proxy.md:255` — "Proxy defaults to using the Node.js runtime. The `runtime` config option is not available in Proxy files. Setting the `runtime` config option in Proxy will throw an error."
- `.../03-file-conventions/proxy.md:806` — "`v16.0.0` | Middleware is deprecated and renamed to Proxy."
- `.../03-file-conventions/middleware.md:11` — "deprecated in Next.js 16 and renamed to `proxy.js`."
- `.../01-app/02-guides/upgrading/version-16.md:616` — "The `edge` runtime is **NOT** supported in `proxy`. The `proxy` runtime is `nodejs`, and it cannot be configured."

**Plan defect found**: this plan's `<context>` cited the upgrade guide at
`node_modules/next/dist/docs/02-guides/upgrading/version-16.md`. The real path in this
install is under `01-app/` — `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`.
A stale citation inherited from the exploration doc. Not a contradiction of the claim.

## Cast decision: RE-DERIVED (kept), retargeted to `NextProxy`

`next-auth/index.d.ts:209-211` (5.0.0-beta.32) types `auth` as an intersection of five call
signatures. Exactly one takes two arguments and it is the Pages Router
`(NextApiRequest, NextApiResponse)` one; there is no `(NextRequest, NextFetchEvent)`
signature at all. The runtime call shape Next.js uses is unrepresented in the type, and that
is orthogonal to Edge vs Node — so the cast survives the migration on its merits.

Confirmed empirically rather than assumed: deleting the cast produced
`src/proxy.ts(280,27): error TS2345: Argument of type 'NextRequest' is not assignable to
parameter of type 'NextApiRequest'.` The file was then restored byte-identical.

One type-level change: `NextMiddleware` → `NextProxy`.
`next/dist/server/web/types.d.ts:63` is `export type NextProxy = NextMiddleware` — the
identical type — and `NextMiddleware` carries `@deprecated Use NextProxy instead`. Zero
behavioural change, and it heeds a deprecation notice AGENTS.md requires attention to.

## Codemod

`npx @next/codemod@canary middleware-to-proxy .` ran and succeeded (exit 0). It renamed the
file and the export. **No comment blocks needed restoring** — the diff against the snapshot
was a single one-line hunk, so all ~180 lines of load-bearing commentary (two matcher
widenings, the measured `/login` DoS, the trust-boundary warning) survived intact.

## Environment setup completed during execution

`npx tsc --noEmit` initially failed with **81 pre-existing errors** unrelated to this plan,
because `node_modules/.prisma` and `.next/types` did not exist. The executor ran
`npx prisma generate` (per the plan's `user_setup`) and `npx next typegen`. Both write only
to gitignored / `node_modules` paths; `package-lock.json` re-verified unchanged. Baseline
reached tsc 0 / lint 0 *before* the Task 3 edits, so the green result is attributable to
this work rather than to the setup.

## Carried forward — NOT fixed here

| Item | Location | Owner |
|------|----------|-------|
| Trust-boundary block still says "Edge middleware function" and that compose has no reverse proxy | `src/proxy.ts` (inside the 39-line warning) | **08-04** — it owns the block; the argument stays valid on Node, only the runtime wording is stale |
| Rate limiter's home named as `src/middleware.ts` | `DEPLOYMENT.md:36`, `:274` | **08-04** (`:274` also goes stale via 08-02) |
| `src/middleware.ts` referenced in test comments | `e2e/fixtures.ts:42,46` | Unowned — `e2e/**` forbidden to every Phase 8 plan |
| "never from Edge middleware" now wrong | `src/lib/session.ts:166` (also `:78`, `:234` prose) | **Unowned — `src/lib/**` is forbidden to every Phase 8 plan.** Needs carrying past this milestone |
| Unused `companyUrl` lint warning | `e2e/sla-tracking.spec.ts:48` | Pre-existing; lint still exits 0 |

## Issues

Four stale-reference items above, two of them unowned by any Phase 8 plan. The
`src/lib/session.ts:166` Edge claim is the one worth tracking — it is now factually wrong
and no plan in this phase may touch it.

## Errors

None.
