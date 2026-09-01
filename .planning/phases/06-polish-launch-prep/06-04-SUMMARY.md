# 06-04 Summary — Playwright E2E Infrastructure

**Status**: Complete

## Files changed
- `playwright.config.ts` (new) — `defineConfig` with `testDir: "./e2e"`, `webServer` running `npm run dev` against `http://localhost:3000` (`reuseExistingServer: !process.env.CI`, `timeout: 60000`), `use: { baseURL: "http://localhost:3000" }`.
- `e2e/fixtures.ts` (new) — exports `ROLE_CREDENTIALS` (technician/dispatcher/sales/finance/admin) and `async function loginAs(page, role)`.
- `package.json` (modified, additive only) — added `@playwright/test": "^1.62.1"` to `devDependencies`, added `"test:e2e": "playwright test"` to `scripts`. No existing script or dependency removed or altered.
- `.gitignore` (modified, additive only) — added a `# playwright` section with `/test-results/`, `/playwright-report/`, `/blob-report/`, `/playwright/.cache/`. Checked first: no existing broad pattern already covered these.

No Wave-2 spec files (`e2e/tickets.spec.ts`, `e2e/time-entry-to-invoice.spec.ts`, `e2e/sla-tracking.spec.ts`) were created. No forbidden files (`src/lib/crypto.ts`, `src/lib/qbo.ts`, `src/lib/actions/tickets.ts`, `src/middleware.ts`, `prisma/schema.prisma`, `prisma/migrations/**`, `src/components/**`, `src/app/**`, `.env.example`) were touched by this plan — those were modified by concurrent sibling agents (06-01/06-02/06-03) working in the same shared worktree; verified via `git diff` scoped to each file this plan owns.

## Verification
- `test -f playwright.config.ts` — pass
- `grep -q '@playwright/test' package.json` — pass
- `grep -q 'test:e2e' package.json` — pass
- `test -f e2e/fixtures.ts` — pass
- `grep -q 'export' e2e/fixtures.ts` — pass
- `grep -q 'loginAs' e2e/fixtures.ts` — pass
- `grep -q 'ROLE_CREDENTIALS' e2e/fixtures.ts` — pass
- `grep -q 'webServer' playwright.config.ts` — pass
- `npm install --save-dev @playwright/test` — succeeded, installed `@playwright/test@1.62.1` (confirmed via `node_modules/@playwright/test/package.json`)
- `npx tsc --noEmit` — 48 pre-existing errors, **zero referencing `playwright.config.ts` or `e2e/fixtures.ts`**. All 48 errors are the documented fresh-worktree Prisma-client-not-generated gap (`node_modules/.prisma/client/` and `src/generated/prisma` both absent — `npx prisma generate` was never run in this worktree) plus the recurring `LayoutProps`/`layout.tsx` fresh-worktree artifact noted in STATE.md for Phases 2-5. Confirmed pre-existing/environmental, not introduced by this plan, by grepping the full error list for the two new files (no matches) and confirming the Prisma client directories don't exist. Generating the Prisma client is out of this plan's `files_modified` scope.

## Decisions made

**Exact login selectors used** (confirmed by reading `src/app/(auth)/login/page.tsx` in full — route is at `(auth)/login`, resolves to URL `/login`):
- Email field: `#email` (`<Input id="email" name="email" type="email" required ... />`, line 60)
- Password field: `#password` (`<Input id="password" name="password" type="password" required ... />`, line 72)
- Submit button: `<Button type="submit">Sign in</Button>` (accessible name "Sign in" while idle, "Signing in..." while submitting) — targeted via `page.getByRole("button", { name: "Sign in" })`
- On success, the page's `handleSubmit` calls `router.push("/")` (client-side navigation) — `loginAs` waits via `page.waitForURL((url) => !url.pathname.includes("/login"))`, which is satisfied by that redirect without hardcoding the exact destination path, and surfaces a normal Playwright timeout (not a custom retry loop) if login fails and the page stays on `/login`.

**Exact credential format confirmed**: `prisma/seed.ts` (read in full) creates exactly 5 users — `technician@mspdemo.local`, `dispatcher@mspdemo.local`, `sales@mspdemo.local`, `finance@mspdemo.local`, `admin@mspdemo.local` — all with the shared password `Password123!` (bcrypt-hashed at rest, guarded by a `NODE_ENV=production` check in the seed script). This is an **exact match** to STATE.md's prose description — no discrepancy found, no stop-gate triggered.

**`playwright.config.ts` extras beyond the minimum spec**: added `fullyParallel: true`, `forbidOnly: !!process.env.CI`, `retries: process.env.CI ? 2 : 0`, and `reporter: "html"` — standard Playwright scaffold defaults that don't conflict with any locked decision in `06-CONTEXT.md` and support Wave 2's specs running cleanly both locally and in CI. `trace: "on-first-retry"` added under `use` for debuggability; does not change `baseURL`.

## Deviations / issues
- None from the plan's required scope. One transient hazard encountered and corrected during execution: an `Edit` to `package.json` (adding `test:e2e`) landed on a stale in-context copy captured before `npm install` had finished writing the file, which silently dropped the just-installed `@playwright/test` devDependency line. Caught immediately by re-reading the file after the edit (this plan's own QA-verification discipline) and fixed with a second additive edit restoring the `@playwright/test` entry. Final `package.json` verified clean via `git diff` — exactly the one new devDependency and one new script, nothing else changed.
- Per the plan's explicit instruction, `npx playwright install` (Chromium binary download) was **not** run — this remains a documented `user_setup` step for the user to run once (`npx playwright install --with-deps chromium`) before `npm run test:e2e` can execute for the first time.
- This worktree is shared with concurrent sibling agents executing Plans 06-01/06-02/06-03 (schema, middleware, `tickets.ts`, `crypto.ts` changes visible in `git status` but not authored by this plan). Only this plan's four owned files were staged/committed.
