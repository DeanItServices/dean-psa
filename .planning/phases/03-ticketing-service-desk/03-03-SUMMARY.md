# 03-03 Summary: Microsoft Graph Email-to-Ticket Poller

## Status
Complete

## Files Modified
- `scripts/email-poller.ts` (new) — standalone Microsoft Graph API email-to-ticket poller. Fail-fast env var validation, `ClientSecretCredential` + `TokenCredentialAuthenticationProvider` + `Client.initWithMiddleware` Graph auth, `pollOnce()` polling loop, sender-to-Contact matching, active-contract resolution (rule shared verbatim with 03-02), SLA deadline computation via `computeSlaDeadlines`, Ticket + TicketComment creation, file-based watermark persistence, 90s `setInterval`.
- `docker-compose.yml` — added `email-poller` service: same `build: .` as `app`, `command: ["npm", "run", "email-poller"]`, `DATABASE_URL` shared with `app` (same value), plus `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`/`MAILBOX_ADDRESS` sourced from `.env` via `${...}` interpolation, `depends_on: [db]`.
- `Dockerfile` — `runner` stage extended with three `COPY --from=builder` lines (`/app/scripts`, `/app/src`, `/app/tsconfig.json`) inserted after the existing `prisma7.config.ts` copy and before `EXPOSE 3000`. `deps`/`builder` stages, `EXPOSE 3000`, and `CMD ["npm", "start"]` unchanged.
- `package.json` — added `@azure/identity` and `@microsoft/microsoft-graph-client` to `dependencies` (npm inserted them alphabetically, additive, did not disturb 03-02's `@dnd-kit/*` entries); added `"email-poller": "tsx scripts/email-poller.ts"` to `scripts`. `tsx` was already present as a devDependency (pre-existing, used by `prisma/seed.ts`) — not re-added.
- `package-lock.json` — updated by `npm install` as an expected side effect (not separately hand-edited).
- `.env.example` — appended `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `MAILBOX_ADDRESS` with one-line explanatory comments each, matching the file's existing comment style.

No files outside `files_modified` were touched. `git status --short` confirms only the 5 listed items (+ `package-lock.json`, an expected `npm install` side effect) changed.

## Verification Results
All plan-level `<verify>` blocks (Tasks 1-3), the frontmatter `verification_commands`, and additional runtime smoke tests passed. No fix cycles were needed.

## Verification Commands Table

| Command | Exit Code | Result |
|---|---|---|
| `test -f scripts/email-poller.ts` | 0 | Pass |
| `grep -q 'AZURE_TENANT_ID' scripts/email-poller.ts` | 0 | Pass |
| `grep -q 'AZURE_CLIENT_ID' scripts/email-poller.ts` | 0 | Pass |
| `grep -q 'AZURE_CLIENT_SECRET' scripts/email-poller.ts` | 0 | Pass |
| `grep -q 'MAILBOX_ADDRESS' scripts/email-poller.ts` | 0 | Pass |
| `grep -q 'pollOnce' scripts/email-poller.ts` | 0 | Pass |
| `grep -Eq 'source:\s*"email"\|source:\s*.email.' scripts/email-poller.ts` | 0 | Pass |
| `npx tsc --noEmit` (after Task 1) | 0 | Pass |
| `grep -q 'email-poller' docker-compose.yml` | 0 | Pass |
| `grep -q 'AZURE_TENANT_ID' .env.example` | 0 | Pass |
| `grep -q 'AZURE_CLIENT_ID' .env.example` | 0 | Pass |
| `grep -q 'AZURE_CLIENT_SECRET' .env.example` | 0 | Pass |
| `grep -q 'MAILBOX_ADDRESS' .env.example` | 0 | Pass |
| `grep -q 'COPY --from=builder /app/scripts' Dockerfile` | 0 | Pass |
| `grep -q 'COPY --from=builder /app/src' Dockerfile` | 0 | Pass |
| `grep -q 'COPY --from=builder /app/tsconfig.json' Dockerfile` | 0 | Pass |
| `grep -q 'CMD \["npm", "start"\]' Dockerfile` | 0 | Pass |
| `npx tsc --noEmit` (final, full project) | 0 | Pass |
| `test -f scripts/email-poller.ts` (frontmatter) | 0 | Pass |
| `grep -q 'scripts' Dockerfile` (frontmatter) | 0 | Pass |
| Runtime smoke test: `npx tsx scripts/email-poller.ts` with no env vars | 1 | Pass — threw `Missing required environment variable: AZURE_TENANT_ID` and exited non-zero, no silent no-op |
| Runtime smoke test: `npx tsx scripts/email-poller.ts` with fake Azure credentials + real `DATABASE_URL` | n/a (long-running, terminated by timeout) | Pass — successfully imported `db`/`sla` modules, initialized the Graph client, made a real network call to `login.microsoftonline.com`, caught the expected `AADSTS900023` auth failure inside `fetchNewMessages`'s try/catch, logged it, and did not crash the process |

## Key Decisions

1. **Reused pre-existing `tsx` devDependency instead of reinstalling.** `package.json` already had `tsx@^4.23.13` as a devDependency (added in an earlier phase for `prisma/seed.ts`). The plan's stop-gate about a script-runner conflict did not apply — `tsx` was already the project's established script-running convention, so I only added the `email-poller` npm script and did not touch the `tsx` dependency entry.
2. **`package.json` re-read fresh before editing, per the plan's explicit instruction.** Confirmed 03-02's `@dnd-kit/core`/`@dnd-kit/sortable` entries were present and committed before running `npm install @microsoft/microsoft-graph-client @azure/identity`. npm inserted the two new packages alphabetically into `dependencies` without disturbing or reordering 03-02's entries; verified via a full re-read after install.
3. **Used `@microsoft/microsoft-graph-client`'s `Client.initWithMiddleware` + `TokenCredentialAuthenticationProvider`** (from `@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials`) rather than hand-rolled OAuth/fetch, per the plan's explicit two-approach constraint. Confirmed the subpath import resolves correctly at runtime via `tsx` (the package has no `exports` map restricting subpath resolution — verified by reading `node_modules/@microsoft/microsoft-graph-client/package.json`).
4. **`import`s use relative paths (`../src/lib/db`, `../src/lib/sla`)**, not the `@/` alias, because `scripts/email-poller.ts` runs via `tsx` outside Next.js's bundler-based module resolution; verified this resolves correctly both under `tsc --noEmit` (project-wide, `@/*` alias is only used by app code) and at runtime via `tsx` (plain relative Node resolution, confirmed by the runtime smoke test successfully reaching past both import statements).
5. **Active-contract resolution query implemented verbatim** per 03-CONTEXT.md's locked rule: `db.contract.findFirst({ where: { companyId, OR: [{ endDate: null }, { endDate: { gte: new Date() } }] }, orderBy: [{ startDate: "desc" }, { id: "desc" }] })`. This must produce identical results to Plan 03-02's `createTicket` implementation of the same rule for the same company — not independently re-verified against 03-02's actual code in this plan's scope (that file is 03-02's, out of this plan's read/write scope), but the query text matches 03-CONTEXT.md's spec exactly.
6. **Watermark storage: JSON file (`.email-poller-state.json`) at repo/cwd root**, per the plan's explicit "implementer's choice... a small JSON file... is acceptable" allowance. Initializes to `new Date()` on first run (no backfill of historical mail, per the edge-case spec). Persisted only after a successful fetch+process batch — a failed Graph API call (confirmed via runtime smoke test) does NOT advance/write the watermark, so a transient auth/network failure cannot cause message loss.
7. **`.gitignore` was deliberately NOT modified**, despite the plan's action-block prose suggesting "add it to `.gitignore` if not already covered by a pattern." `.gitignore` is not listed in this plan's `files_modified` (`scripts/email-poller.ts`, `docker-compose.yml`, `Dockerfile`, `package.json`, `.env.example` only), and the harness's "you may only create, edit, or delete files listed in `files_modified`" rule is stricter than and takes precedence over the narrative suggestion inside a task's `<action>` block. I initially added the pattern, caught the scope conflict, and reverted it (confirmed via `git status`/`git diff` showing zero net change to `.gitignore`). **Documented follow-up**: `.email-poller-state.json` is currently NOT covered by any existing `.gitignore` pattern (checked — no `.email*` or similar wildcard exists), so once the poller runs for the first time in a real environment, `git status` will show it as untracked. This is a one-line, low-risk gap for a future plan or a manual `.gitignore` addition to close; it does not block any of this plan's functionality, and no watermark file was left behind in this worktree (confirmed via `ls`/`git status` after the runtime smoke tests — the fake-credential smoke test failed before `saveWatermark` was ever called).
8. **Message body handling**: `description`/comment `body` is populated from `message.body.content` (full HTML/text body per Graph's `body` field) if present, falling back to `message.bodyPreview` (plain-text truncated preview), falling back to a literal `"(no message body)"` placeholder — never left undefined/null, since `TicketComment.body` and `Ticket.description` are both required non-nullable `String` fields per the schema.
9. **429 rate-limit handling**: per the plan's edge case, no aggressive in-tick retry is implemented. A 429 is caught, `Retry-After` is logged if present, and the function returns an empty message array — the next scheduled 90s tick serves as the natural backoff, exactly as specified.
10. **`require.main === module` guard** added so `startPolling()` only auto-executes when the file is run directly (`tsx scripts/email-poller.ts`), not when imported as a module — this keeps `pollOnce`, `processMessage`, `resolveActiveContract`, `loadWatermark`/`saveWatermark` cleanly importable/extendable by Plan 03-04 without triggering a live `setInterval` loop as a side effect of importing the file.

## Issues Encountered
None requiring escalation. All installs, type-checks, and runtime smoke tests succeeded on first attempt. The `.gitignore` scope question (Decision 7) was self-caught and self-corrected within this session, not left as an open issue.

## Escalations
None.

## Handoff Context (for Plan 03-04)

**`pollOnce()` location and structure** — the exact integration point Plan 03-04 needs:

- File: `scripts/email-poller.ts`
- Signature: `export async function pollOnce(): Promise<void>` (top-level, exported, `async`)
- Current body structure (in order):
  1. `const since = loadWatermark();`
  2. `const messages = await fetchNewMessages(since);`
  3. Early return if `messages.length === 0` (no-op path)
  4. `let latestProcessed = since;` — tracked across the loop
  5. `for (const message of messages) { ... await processMessage(message) ... }` — each message wrapped in its own try/catch so one bad message can't crash the tick or block the watermark
  6. `saveWatermark(latestProcessed);` at the end of the function — this is the **last statement** in `pollOnce()`

- **Recommended extension point for 03-04's SLA breach-check logic**: add it as an additional step *after* the existing email-ingestion loop and *before or after* `saveWatermark(latestProcessed)` — the watermark write is unrelated to breach-checking (breach-checking queries existing `Ticket` rows, not new Graph messages), so ordering relative to `saveWatermark` doesn't matter functionally. Suggested pattern: extract email-ingestion into its own effectively-already-isolated block (it already is, structurally) and add a sibling call like `await checkSlaBreaches();` inside the same `pollOnce()` function body, so both concerns still execute on the same 90s tick as 03-CONTEXT.md specifies ("The SAME poller process, on the same tick, also runs a breach-check query").
- **Reusable helpers already in this file that 03-04 will likely want**: `getSlaStatus` is NOT currently imported here (only `computeSlaDeadlines` is) — 03-04 will need to add `import { getSlaStatus } from "../src/lib/sla";` itself. The `db` import (`import { db } from "../src/lib/db";`) is already present and reusable as-is.
- **Module-load side-effect guard**: `startPolling()` (which calls `pollOnce()` once immediately, then on a 90s `setInterval`) only runs when `require.main === module` is true. If 03-04 adds tests that `import { pollOnce } from "./email-poller"`, no live polling loop or `setInterval` will fire as a side effect of that import.
- **Env var validation happens at module top level** (`requireEnv()` calls for all 4 Azure/mailbox vars execute immediately on import, before any function is called) — 03-04 should be aware that importing this module without those 4 env vars set will throw immediately, same as running the script directly. This is unchanged/expected behavior, not something 03-04 needs to work around unless it specifically wants to unit-test `checkSlaBreaches()` in isolation without a full Graph/Azure env — in that case, 03-04 may want to consider extracting breach-check logic to prevent needing those 4 vars just to test SLA logic (implementer's judgment call for that plan, not resolved here).

## Requirements Covered
- **Email-to-ticket creation**: Fully implemented for this plan's scope. `scripts/email-poller.ts` polls the Microsoft Graph API (NOT IMAP, per the user's explicit correction) on a 90-second interval (within 03-CONTEXT.md's 1-2 minute range), creates `Ticket` rows with `source: "email"` and an initial non-internal `TicketComment` for messages from senders matched to an existing `Contact`, resolves the matched Contact's company's active contract using the exact locked rule shared with Plan 03-02, computes SLA deadlines via the shared `computeSlaDeadlines` helper, and persists a watermark to a git-ignorable (see Decision 7) local file so restarts do not reprocess already-ingested messages. Unmatched senders are logged and skipped (documented, deliberate limitation per 03-CONTEXT.md, not a bug). Runs as its own Docker Compose service (`email-poller`) sharing `DATABASE_URL` with `app`, and the built image can actually execute it (Dockerfile `runner` stage now includes `scripts/`, `src/`, `tsconfig.json`, and `tsx` was already present in `node_modules`).
- **SLA timers and breach escalation, driven by contract terms**: Partially advanced (SLA deadline computation at ticket-creation time is wired into the email path, matching 03-02's manual-creation path) — breach-check/escalation logic itself remains Plan 03-04's scope, not implemented here, per 03-CONTEXT.md's plan-structure division.
- **Kanban-style ticket boards/queues for dispatch**: Not applicable to this plan (owned by 03-02, already complete).

Azure AD credentials were not available in this environment (expected, per `user_setup` in the plan frontmatter) — the script's logic and structure were implemented in full and verified via type-checking plus two runtime smoke tests (missing-env fail-fast, and a real network call to Microsoft's Azure AD endpoint with fake credentials that exercised the full Graph-client initialization and error-handling path). The requirement to provision a real Azure AD app registration (`Mail.Read`/`Mail.ReadWrite` application permission, admin consent, and the shared mailbox address) remains documented in `.env.example` and the plan's `user_setup` field for the user to complete before this poller can authenticate against a real mailbox.
