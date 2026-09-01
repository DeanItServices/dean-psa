# 06-01 Summary: QBO Token Encryption

**Status: Complete**

## Files changed

- `src/lib/crypto.ts` (new) — AES-256-GCM `encrypt`/`decrypt` helpers.
- `src/lib/qbo.ts` (modified) — encryption wired into `getValidQboClient()`'s three DB-boundary token touch points.
- `src/app/api/qbo/callback/route.ts` (modified, **deviation from the `files_modified` list, pre-approved by the plan's own execution contract** — see "Additional write site found" below).
- `.env.example` (modified) — documents the new required `TOKEN_ENCRYPTION_KEY` var.

No other files were touched. `prisma/schema.prisma`, `src/lib/actions/tickets.ts`, `src/middleware.ts`, `playwright.config.ts`, `package.json`, `src/components/**`, and `src/app/**` (other than the one deviation above) were left untouched.

## Additional write site found (Step 1 grep)

Per the plan's execution contract Step 1, grepped the full `src/` tree for `db.quickBooksConnection.*`. Found four call sites total:

- `src/lib/qbo.ts:147` — `findFirst()` (read) — in scope, updated.
- `src/lib/qbo.ts:163` — `update()` (write) — in scope, updated.
- `src/app/api/qbo/callback/route.ts:58` — `create()` (write, initial OAuth connection) — **outside the original `files_modified` list**, but the plan's "Forbidden actions" section explicitly pre-authorized this exact scenario: *"if either does [write accessToken/refreshToken], that call site must also be updated and is implicitly in this plan's scope even though not listed above."* Updated: `tokens.accessToken`/`tokens.refreshToken` are now encrypted immediately before the `create()` call.
- `src/app/(dashboard)/admin/quickbooks/page.tsx:61` — `findFirst()` (read) — only `connection.realmId` is read/displayed; `accessToken`/`refreshToken` are never touched. No change needed.

This is documented as a deviation, not a stop-gate `BLOCKED` condition, because the plan's own contract pre-authorized updating an OAuth-route write site if found, and named `src/app/api/qbo/callback/route.ts` by name as the specific file to check.

## `encrypt()` output format

Single self-contained string: `base64(iv):base64(authTag):base64(ciphertext)` — 12-byte random IV, 16-byte GCM auth tag, colon-separated. `decrypt()` splits on `:` (expects exactly 3 parts) and reverses exactly. No additional stored state needed beyond the string itself.

## Key handling

`getEncryptionKey()` (internal, non-exported) reads `process.env.TOKEN_ENCRYPTION_KEY`, base64-decodes it, and throws a single clear, actionable error (including the exact `node -e` key-generation command) if the var is missing or the decoded buffer isn't exactly 32 bytes.

## `getValidQboClient()` changes

- Reads `connection.accessToken`/`connection.refreshToken` and decrypts both immediately after the `findFirst()` query, inside a try/catch.
- On decrypt failure: logs `console.error("QBO token decryption failed -- TOKEN_ENCRYPTION_KEY may be missing, rotated, or the stored data is corrupted:", err)` (the exact distinguishable diagnostic required by the CRITICAL plan-critique finding) and returns `null` — never throws uncaught. Does not log ciphertext, key, or plaintext.
- Non-refresh path returns the decrypted plaintext `accessToken`.
- Refresh path: calls `refreshAccessToken()` with the decrypted refresh token, encrypts both new tokens via `encrypt()` before the `update()` call, and returns the already-in-hand plaintext `refreshed.accessToken` (avoids re-decrypting the just-written value).
- External contract unchanged: `Promise<{ accessToken: string; realmId: string } | null>`, decrypted plaintext returned to callers, null-on-failure behavior preserved (now also covers decrypt failure, not just refresh failure).

## Verification

All plan verification commands pass:

```
test -f src/lib/crypto.ts                              PASS
grep 'export function encrypt' src/lib/crypto.ts        PASS
grep 'export function decrypt' src/lib/crypto.ts        PASS
grep 'createCipheriv' src/lib/crypto.ts                 PASS
grep 'createDecipheriv' src/lib/crypto.ts                PASS
grep 'TOKEN_ENCRYPTION_KEY' src/lib/crypto.ts            PASS
grep 'aes-256-gcm' src/lib/crypto.ts                     PASS
grep 'from "@/lib/crypto"' src/lib/qbo.ts                PASS
grep 'encrypt(' src/lib/qbo.ts                           PASS
grep 'decrypt(' src/lib/qbo.ts                           PASS
grep 'TOKEN_ENCRYPTION_KEY' .env.example                 PASS
npx tsc --noEmit                                         PASS for all 4 files touched by this plan
                                                           (crypto.ts, qbo.ts, callback/route.ts: zero errors;
                                                            one unrelated pre-existing project-wide error remains
                                                            in src/app/layout.tsx -- `LayoutProps` -- not in this
                                                            plan's scope and not caused by this plan's changes)
```

Ran `npx prisma generate` (read-only, no schema change) to clear a stale/ungenerated-client false-positive on `db.quickBooksConnection` typings that predated this plan's changes.

Additionally ran a standalone functional smoke test (temporary script, deleted after use, never committed) exercising the module directly:
- Round-trip `encrypt()` -> `decrypt()` recovers the original plaintext. PASS
- `decrypt()` with the wrong key throws (`Unsupported state or unable to authenticate data` -- GCM auth tag verification). PASS
- `encrypt()`/`decrypt()` with a missing `TOKEN_ENCRYPTION_KEY` throws the clear actionable error. PASS
- `decrypt()` on a plaintext (non-ciphertext-shaped) string throws a clear "Malformed ciphertext" error rather than a cryptic crash -- confirms the pre-migration plaintext-row edge case is handled safely. PASS

## Decisions made

- `encrypt()`/`decrypt()` output format: colon-joined base64 triple (see above), documented in a comment above `encrypt()` in `src/lib/crypto.ts`.
- Malformed/wrong-part-count ciphertext input throws a dedicated `"Malformed ciphertext: expected iv:authTag:ciphertext format."` error rather than letting a raw `Buffer.from`/`createDecipheriv` exception surface -- makes the pre-migration-plaintext-row edge case's failure mode explicit and easy to recognize in logs (still caught and turned into a `null` return + diagnostic by `getValidQboClient()`).
- In the refresh-write path, `getValidQboClient()` returns `refreshed.accessToken` (the plaintext already in hand from the token endpoint response) rather than re-decrypting `updated.accessToken` from the Prisma `update()` result -- functionally identical (the encrypted value decrypts back to the same plaintext) but avoids a redundant decrypt call and a theoretical extra failure point immediately after a successful write.
- Additional write site (`src/app/api/qbo/callback/route.ts`) updated per the plan's own pre-authorization for this exact scenario; treated as an in-scope deviation, not a stop-gate.

## Issues / notable events during execution

- Mid-execution, a `git stash`/`git stash pop` diagnostic step (used to compare a clean baseline typecheck) briefly interacted with other agents' concurrent uncommitted work in this shared worktree (Plan 06-02's `middleware.ts`/`tickets.ts`, Plan 06-03's `schema.prisma`, Plan 06-04's `package.json`/`e2e/`/`playwright.config.ts`). No other agent's work was lost: the stash was inspected before any destructive action, only this plan's own three-file diff was surgically re-applied via `git apply` on a verified-clean pre-image, and the stash was left in place (not dropped) as a safety net since other agents had already independently re-landed their own changes live to disk by the time this was discovered. Recommend avoiding `git stash` for diagnostic purposes in a multi-agent shared worktree going forward -- a plain `git diff`/`git worktree`-scoped comparison is safer.
- No plaintext token value is logged anywhere in the modified code paths.

## Migration note (for `user_setup`, already captured in the plan frontmatter)

Any existing plaintext `QuickBooksConnection` row will fail to decrypt after this change (by design -- `decrypt()` throws on non-ciphertext-shaped input, caught by `getValidQboClient()` and converted to a `null` return with a diagnostic log). A `TOKEN_ENCRYPTION_KEY` value must be generated and set in the environment before running the app, and any existing connection must be re-established via `/admin/quickbooks` after deploying this change.
