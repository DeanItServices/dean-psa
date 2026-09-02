# 07-06 Summary — Bootstrap and runbook

**Status**: Complete
**Wave**: 3
**Agent**: engineering-backend-architect (+ devops)
**Date**: 2026-09-02

## What was done

| File | Change |
|---|---|
| `scripts/create-admin.ts` | **New**, 480 lines. |
| `package.json` | One line: `"bootstrap:admin": "tsx scripts/create-admin.ts"`, next to `email-poller` and matching its form. |
| `DEPLOYMENT.md` | New account-creation/onboarding section; the ~line-190 known-limitations bullet rewritten; a migration-ordering warning added to "Database migration"; date stamp updated. |

`prisma/seed.ts` untouched — verified by empty diff; its `ALLOW_SEED_IN_PRODUCTION` guard rail
remains, retired only as the *documented path*.

## This plan was actually exercised

Unlike every other plan in this phase, 07-06 was driven end to end against the dev database
through a real pseudo-terminal (`script -qec`, with `DATABASE_URL` read out of `.env` by a Node
driver so it never touched a command line).

Created row, read back with a fresh `findUniqueOrThrow` rather than echoing input:

```
  id                 cmtka0pc6000025syrdjc88d5
  email              bootstrap-probe@example.invalid
  name               Bootstrap Probe
  role               admin
  isActive           true
  mustChangePassword false
```

Invoked with `BootStrap-Probe@Example.Invalid` → stored lowercased, proving the `authorize()`
compatibility invariant. The run deliberately entered a 5-character password and then a mismatched
confirmation, exercising both re-prompt paths.

**Cleanup verified by the orchestrator, not just claimed**: a direct query against the running
container returns exactly the five `@mspdemo.local` fixtures, all `isActive: t`,
`mustChangePassword: f`. The probe row is gone.

Runtime paths exercised: `--help` (0), non-TTY refusal (1), too-many-arguments refusal (1), unknown
flag (1), `DATABASE_URL` unset (1), create with both re-prompts (0), duplicate refusal (1), reset
confirmed (0), reset aborted (1), reset against a non-admin (1).

## Argument interface and echo suppression

```
npm run bootstrap:admin                              # prompts for name, email, password
npm run bootstrap:admin -- admin@yourmsp.com         # email from argv, password prompted
npm run bootstrap:admin -- --reset-password [email]  # break-glass
npm run bootstrap:admin -- --help
```

**The password cannot come from argv**, enforced three ways: a second positional argument is
rejected outright with a message explaining shell history and `ps`; no code path reads a
password-shaped env var; a non-TTY stdin exits 1 rather than accepting an empty string.

Echo suppression uses only `node:readline/promises` + `node:stream` — no new dependency and no
reach into readline's private `_writeToOutput`. The interface is built with `terminal: true` over
a `Writable` that drops writes while muted, so readline's per-keystroke echo is swallowed while the
prompt (written synchronously before the promise returns) stays visible. `output.columns` is
redefined as a getter onto `process.stdout.columns` so readline's line-redraw math still works.

`MIN_PASSWORD_LENGTH` is **imported** from `src/lib/validations/user.ts`, not restated, and enforced
in both the create and reset prompts, **re-prompting** rather than exiting. Entry is confirmed
twice — a typo into an invisible prompt would otherwise produce an admin account nobody can log
into, on the one account whose only recovery path is this same script.

Email validation is delegated to 07-03's `createUserSchema`, so a bootstrap admin cannot exist in a
shape `/admin/users` would reject.

## `--reset-password`

Non-default, explicit. Prints the target's id, email, name, role and active state, then requires the
operator to **type that account's email back** before writing. Sets `hashedPassword` +
`mustChangePassword: false`, then reads the row back. Refuses a non-`admin` target (that is
`/admin/users`' job) and refuses a nonexistent one.

It deliberately does **not** flip `isActive` — it warns instead that resetting an inactive account's
password changes nothing, because `authorize()` rejects `!isActive` before comparing any password.
Reactivation is a decision, not a side effect.

## DEPLOYMENT.md

Four edits, covering **both** stale sites:

1. `## Database migration` — a warning blockquote before the run instructions.
2. New `## Creating the first admin account and onboarding the team`, carrying the
   `<!-- Phase 8: revisit for Caddy/TLS topology -->` marker, with subsections for the TLS
   precondition, migration ordering, `bootstrap:admin`, onboarding, `--reset-password`, and the
   deactivation note.
3. `## First-run verification` reduced to what it should always have been, and stating explicitly
   that *"the previous guidance in this document (a modified seed run, or a hand-written `psql`
   insert) is obsolete and should not be followed."*
4. **The second stale site** — the known-limitations bullet rewritten from "No admin/signup UI to
   create real user accounts" to "Account management exists; self-service signup does not", naming
   what genuinely remains absent (self-service signup, self-service reset, email invites, audit
   log) and that `docker compose logs app` is not tamper-evident.

The migration-ordering paragraph spells out the whole failure chain: `authorize()` uses `findUnique`
with no `select` → Prisma asks for every column → P2022 on every login and every authenticated page
load → `loginAction` translates it into the same "Invalid email or password" the wrong password
produces → every user including every admin locked out with no in-app signal, recoverable only via
host shell. It states the safe order: pull → `npm install && npx prisma generate` →
`db:migrate:deploy` → build → up.

The TLS paragraph is equally direct: with `"3000:3000"` and no proxy, every admin password, every
temp password, and every session cookie crosses the network in plaintext, and no rotation revokes
an already-stolen 8-hour token. Bootstrapping one admin over loopback to prove the deployment works
is fine; distributing credentials to staff is not.

## Verification

All 16 plan and task greps pass. Orchestrator re-ran on the merged tree:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npm run lint` | 0 errors, 1 pre-existing warning |
| `git diff --stat HEAD -- prisma/seed.ts` | empty — untouched |
| `role: "admin"` in the script | 2 occurrences |
| `MIN_PASSWORD_LENGTH` imported | yes |
| `bootstrap:admin` in package.json | yes |
| database after probe | exactly 5 seed fixtures, all active |

## Decisions

- **Display-name prompt added** (defaults to the email local part). A small scope addition, flagged
  as such: `name` is nullable and the plan did not mention it, but the sidebar and every author
  byline render it, and a null-named sole admin is a worse first impression than one Enter keypress.
- **Password confirmation prompt added** — not in the plan, but the entry is invisible.
- **Validation delegated to `createUserSchema`** rather than a local regex, so bootstrap and UI
  cannot diverge on what a valid email is.
- **Prisma error codes duck-typed** (`"code" in error`) rather than `instanceof`, so P2022/P2002/P1001
  handling does not depend on which module path that class is exported from in a given Prisma major.
- **`DATABASE_URL` guidance recommends `set -a; . ./.env; set +a`** over an inline
  `DATABASE_URL=... npm run …` prefix, and says why: the connection string carries the database
  password and the inline form lands in shell history. Refusing the admin password on the command
  line and then recommending the DB password there would have been inconsistent.

## Auto-remediation

Two, both caught by running the output rather than reading it:

1. A `console.error(a, b)` implicit space produced a stray mid-sentence space; changed to concatenation.
2. The first `DATABASE_URL` message led with the inline `DATABASE_URL=...` form — self-contradictory
   next to this script's premise. Reordered to lead with the shell-export form, with the reason.

## Risks and follow-ups

1. **The runbook points at `/admin/users`, built by 07-05 in parallel.** Written anyway per the
   plan. 07-07 verifies the two agree. (07-05 did land — the route exists.)
2. **Host shell access is now equivalent to admin access to this application.** `--reset-password`
   is a deliberate, documented trade against having no recovery path at all for a locked-out sole
   admin. The runbook says so in one sentence.
3. **The onboarding steps describing the `/admin/users` dialog were written from 07-03's and
   07-05's plans, not from clicking the UI.** Wording like "displays it exactly once" should be
   checked against 07-05's actual dialog during 07-07.
4. **The script has no automated test.** Its behaviour is proven only by the pty transcripts. A
   future refactor of the muting logic has nothing to catch a regression that silently un-suppresses
   the echo — the failure mode being a production admin password printed to a terminal and its
   scrollback.
