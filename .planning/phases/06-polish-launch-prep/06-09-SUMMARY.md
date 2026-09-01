# 06-09 Summary: Deployment Documentation

**Status: Complete**

## Files changed

- `DEPLOYMENT.md` (new, repository root, 169 lines) — full deployment runbook.

No other files were touched. `git status --porcelain` confirms only `DEPLOYMENT.md` is untracked/new; no forbidden targets (`docker-compose.yml`, `Dockerfile`, `.env.example`, `package.json`, any `src/**`, `prisma/**`, `e2e/**`, `playwright.config.ts`) were modified.

## Pre-write verification: all 8 prior plans confirmed Complete

Read all 8 SUMMARY.md files in full before writing anything:

| Plan | Status field |
|------|-------------|
| 06-01 (QBO Token Encryption) | Complete |
| 06-02 (RBAC Hardening + Rate Limiting) | Complete |
| 06-03 (Database Indexes) | Complete |
| 06-04 (Playwright E2E Infrastructure) | Complete |
| 06-05 (UI Consistency) | Complete |
| 06-06 (E2E Spec: Ticket Lifecycle) | Complete |
| 06-07 (E2E Spec: Time Entry to Invoice) | Complete |
| 06-08 (E2E Spec: SLA Tracking) | Complete |

No stop-gate triggered — all 8 files exist and all report `Status: Complete`.

## Source files read (current, post-Phase-6 state)

`docker-compose.yml`, `Dockerfile`, `.env.example`, `package.json` — all read in full. Confirmed `.env.example` contains `TOKEN_ENCRYPTION_KEY` (added by 06-01) and `package.json` contains `test:e2e` (added by 06-04) and `db:migrate:deploy` (pre-existing, chains `prisma migrate deploy && bash scripts/post-migrate.sh`, confirmed unchanged from Phase 4).

Additionally read/grepped, beyond the plan's minimum required list, to verify claims before writing them:
- `prisma/seed.ts` (full) — confirmed the 5 seeded demo users, shared password, and the `NODE_ENV=production` guard (`ALLOW_SEED_IN_PRODUCTION` override).
- `src/auth.ts` (partial, the Credentials provider) — confirmed there is no user-creation path in the auth flow itself (only `db.user.findUnique` + `compare()`), and confirmed `bcryptjs` is the hashing library referenced in the DEPLOYMENT.md bootstrap-account guidance.
- Project-wide search for a signup/registration route or admin user-management screen — none found (only `bcryptjs`/`hashedPassword` reference in the whole `src/` tree is `src/auth.ts`; `db.user.create`/`user.create(` has zero matches in `src/`).
- `.planning/phases/04-time-tracking-billing/04-REVIEW.md` (full) — the QBO Item-mapping caveat text specified in the plan ("SalesItemLineDetail.ItemRef.value hardcoded placeholder") is **not actually present in this document**. It is a WARNING-severity finding (#6/#7) about missing error logging, already fixed — not about Item-mapping at all.
- `src/lib/actions/invoices.ts` (grepped) — the actual Item-mapping caveat lives here, as an in-code comment at lines 352-367 (`ItemRef.value` hardcoded to `"1"`), not in `04-REVIEW.md`.

## Deviation from the plan: QBO caveat pointer corrected

The plan instructed pointing to `.planning/phases/04-time-tracking-billing/04-REVIEW.md` for "the QBO Item-mapping caveat (the `SalesItemLineDetail.ItemRef.value` hardcoded placeholder)". Verification (per this plan's own "evidence-before-action" contract) found this caveat is **not in that document** — `04-REVIEW.md` contains no `ItemRef`, `SalesItemLineDetail`, or Item-mapping text at all. The actual, accurate source of this caveat is an in-code comment in `src/lib/actions/invoices.ts` (lines 352-367).

Rather than citing a document that doesn't contain the claimed content (which would fail on a reader's first click-through and undermine trust in the rest of the runbook), `DEPLOYMENT.md`'s Operational Notes section documents the caveat directly, with an accurate pointer to the real source (`src/lib/actions/invoices.ts` around lines 352-367) instead of the inaccurate `04-REVIEW.md` pointer. This is a factual correction in service of the plan's own "do not document aspirational/planned behavior" and "cross-checked against the real file, not reconstructed from memory" mandates, not a scope deviation.

## First-run verification: real finding, not aspirational

Per the plan's edge case ("check whether a signup flow exists or how the first admin actually gets created, document whichever is true"), confirmed via source read that **no signup flow and no admin-user-management UI exist in this application at all**. The only way any `User` row is ever created is `prisma/seed.ts` (demo data, production-guarded) or a direct database write. `DEPLOYMENT.md`'s "First-run verification" section documents this honestly as a real operational gap requiring a manual one-time bootstrap step (a modified seed run with `ALLOW_SEED_IN_PRODUCTION=true`, or a direct DB insert), and flags it again in "Operational notes" as something worth fixing in a future phase — rather than glossing over it or inventing a signup flow that doesn't exist.

## Infrastructure-file gaps found but not fixed (per plan's edge-case instruction)

No gap requiring a `docker-compose.yml` or `Dockerfile` change was found. Both files fully support every step documented in `DEPLOYMENT.md` as written:
- `docker-compose.yml` already publishes the two ports the runbook references (`3000` for `app`, `${DB_PORT:-5432}` for `db`); `email-poller` correctly has no published port.
- `Dockerfile`'s runner stage already copies `scripts/` (needed for `scripts/post-migrate.sh`) and `prisma/` (needed for migrations).

No infrastructure file edit was needed or attempted; both remain untouched per the plan's forbidden-targets list.

## Other gaps documented in DEPLOYMENT.md (not infra-file gaps, application-level, out of this plan's fix scope)

Called out explicitly in the "Operational notes" section, each with a pointer to its real source, consistent with 06-02's and 06-06's own findings:
- Rate-limit thresholds are hardcoded constants in `src/middleware.ts`, not env-configurable — tuning requires a code change + rebuild.
- `deleteTicket`'s ownership-scoped check (06-02) has no UI entry point anywhere in the app (confirmed by 06-06's own project-wide search, re-cited here) — noted as an operational awareness item, not a blocker.
- No admin/signup UI exists to create real user accounts (see above).
- QBO Item-mapping placeholder (`ItemRef.value` hardcoded to `"1"` in `src/lib/actions/invoices.ts`) — corrected pointer as described above.

## Verification

```
test -f DEPLOYMENT.md                          PASS
grep -q 'TOKEN_ENCRYPTION_KEY' DEPLOYMENT.md    PASS
grep -q 'docker compose' DEPLOYMENT.md          PASS
grep -q 'db:migrate:deploy' DEPLOYMENT.md       PASS
grep -q 'test:e2e' DEPLOYMENT.md                PASS
wc -l DEPLOYMENT.md                              169 lines (>= 40 min_lines required)
git status --porcelain                           only DEPLOYMENT.md (untracked) -- no forbidden file touched
```

Every command shown in `DEPLOYMENT.md` was cross-checked against a real script in `package.json` or a real Docker Compose invocation:
- `docker compose build` / `docker compose up -d` / `docker compose ps` / `docker compose logs -f` — standard Compose v2 commands, consistent with `docker-compose.yml`'s 3 services.
- `npm run db:migrate:deploy` — matches `package.json` exactly.
- `npx playwright install --with-deps chromium` — matches 06-04's documented `user_setup` step verbatim.
- `npm run test:e2e` — matches `package.json` exactly.
- `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` — matches `.env.example`'s own documented generation command verbatim.
- `npx auth secret` / `openssl rand -base64 32` — matches `.env.example`'s `AUTH_SECRET` comment verbatim.

## Decisions made

- Documented the rate-limiting internet-exposure caveat in "Prerequisites" (network/firewall section) as instructed by the plan, without re-documenting the RBAC/ownership-delete application logic itself (kept to deployment/operations relevance only, per the plan's must-have constraint).
- Used the accurate in-code location for the QBO Item-mapping caveat instead of the plan's specified (but incorrect) `04-REVIEW.md` pointer — see "Deviation" above.
- Documented the real admin-account-bootstrap gap plainly rather than glossing over it, since inventing a signup flow that doesn't exist would violate the plan's "do not document aspirational behavior" constraint.
- Called out E2E test data as additive/non-cleaned-up in the "Running E2E verification" section, recommending staging-only execution — an inference drawn from 06-06/06-07/06-08's SUMMARYs (each creates throwaway timestamped test data with no teardown step), not explicitly asked for by the plan but directly relevant to safe operational use of `npm run test:e2e`.

## Issues / errors

None blocking. No stop-gate was triggered. The one deviation (QBO caveat pointer) is a factual correction, documented above, that improves the runbook's accuracy rather than reducing its scope.
