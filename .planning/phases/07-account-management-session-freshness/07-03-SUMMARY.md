# 07-03 Summary — User lifecycle Server Actions

**Status**: Complete
**Wave**: 2
**Agent**: engineering-backend-architect
**Date**: 2026-09-02

## What was done

| File | Change |
|------|--------|
| `src/lib/permissions.ts` | +12 lines: `ADMIN_MANAGE_ROLES: Role[] = ["admin"]` with a doc comment, at the head of the `*_ROLES` block. No new `Permission` literal. |
| `src/lib/validations/user.ts` | **New.** `MIN_PASSWORD_LENGTH = 12`, `ROLE_VALUES`, `createUserSchema`, `updateUserRoleSchema` + inferred Input types. |
| `src/lib/actions/users.ts` | **New.** `createUser`, `updateUserRole`, `resetUserPassword`, `deactivateUser`, `reactivateUser`. |

## The last-active-admin invariant

Mechanism chosen: **`pg_advisory_xact_lock` under the default READ COMMITTED**, taken as the
first statement inside the transaction.

```ts
await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_INVARIANT_LOCK_KEY}::bigint)`;
```

The agent verified both permitted mechanisms were available before choosing, then argued for the
lock on determinism: the waiter blocks, and when it resumes its `COUNT` is a *new statement*, so
READ COMMITTED takes a fresh snapshot and it observes the committed change. No abort, no retry
budget. Serializable would instead let the waiter proceed on a stale transaction-wide snapshot and
be stopped only by SSI aborting at COMMIT with SQLSTATE 40001 — making correctness depend on
`@prisma/adapter-pg` translating that to `P2034`, an error-translation detail rather than a
database guarantee. It also noted the two do **not** compose: adding Serializable on top would
destroy the fresh-snapshot property the lock relies on.

**It proved this empirically** with a transient, non-mutating probe against the live database
(created, run, deleted; confirmed absent from `git status`):

```
B starting transaction at  156ms
A acquired lock at  161ms
A isolation level: read committed
A committed (lock released) at  971ms
B acquired lock at  971ms
```

B blocked ~815ms and acquired in the same millisecond A committed. The probe also confirmed the
hazard the plan names — a default `db.$transaction` really does run at `read committed` — and that
`isolationLevel: Serializable` *is* available, so the rejection is a design choice, not a
capability gap.

**Stated trade-off**: advisory locks are cooperative. They exclude only code taking the same key.
Sufficient today because every path that can *reduce* the active-admin count routes through the
helper; `createUser` and `reactivateUser` only increase it.

## Guard rails

| Action | Self-target | Last-active-admin | Serialized |
|---|---|---|---|
| `createUser` | n/a | n/a (only increases) | no |
| `updateUserRole` | refused | refused (active-admin demotion only) | advisory lock |
| `resetUserPassword` | **refused** | n/a | no |
| `deactivateUser` | refused | refused | advisory lock |
| `reactivateUser` | allowed (no-op) | n/a | no |

Every self-target check compares against `actor.id` from `requireRole`, never a client-supplied
id. `updateUserRole` runs the count only when demoting an *active* admin — demoting an already
inactive one removes nobody who can log in, so it is never wrongly refused.

## Temp password handling

Length 20, alphabet `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (32 symbols, no `0/O/1/I/l`), 100 bits of
entropy, `crypto.randomBytes`, bcrypt cost 10 matching the seed, hashed **before** any transaction
opens.

The 32-symbol alphabet is deliberate: `256 % 32 == 0`, so `byte % 32` is uniform. A 62-symbol
alphanumeric set would bias `byte % 62` toward the first 8 symbols. A module-load assertion
prevents a future edit from silently reintroducing that bias.

## Verification

Agent-run and **independently re-run by the orchestrator** against the merged tree:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npm run lint` | 0 errors |
| advisory lock is first statement in `$transaction` | confirmed by inspection |
| `console.` calls in `users.ts` | 1 — the lifecycle breadcrumb, payload `{event, action, actorId, targetUserId, at}`, no password/hash/email |
| `.delete(` / `deleteMany` in `users.ts` | **0** |
| `actor.id` references | 9 |
| `MIN_PASSWORD_LENGTH` across the tree | 3 copies, all `12`, in agreement |

## Decisions

- **`ROLE_VALUES` is a string tuple, not the Prisma `Role` enum imported as a value** — these
  schemas will be imported by 07-05's client form, and pulling `@prisma/client` into a client
  bundle is a weight and leak hazard. Drift is caught by `tsc` at the call site.
- **Zod ordering** `z.string().trim().toLowerCase().pipe(z.email(...))`, verified against zod's
  own declarations that `.toLowerCase()` returns `this` so it runs as a transform before the piped
  validator. Normalising after validating would reject a legitimate address with a stray space.
- **`"admin"` stays a literal in the invariant predicates**, deliberately not reusing
  `ADMIN_MANAGE_ROLES`: that constant means "who may manage users", not "who counts as an admin".
  They coincide today; conflating them means widening the permission later would silently change
  the invariant.
- **`deactivateUser` is idempotent**; `reactivateUser` takes no lock and does not reset the password.
- **Explicit `{ maxWait: 5_000, timeout: 10_000 }`** rather than Prisma's 2s/5s defaults, because
  `timeout` now also bounds how long a waiter may block on the lock.

## Risks and follow-ups

1. **The advisory lock is cooperative.** Any future code path that deactivates or demotes an admin
   without calling `withAdminInvariantLock` is unserialized against these actions. Nothing else
   does today. The helper's doc block says so.
2. **`revalidatePath("/admin/users")` targets a route 07-05 has not created yet** — harmless no-op
   until then, per the plan.
3. **`countOtherActiveAdmins` has no covering index** on (`role`, `isActive`). Irrelevant at this
   table's size; noted so it is not a surprise later.
4. **Peer-admin actions remain unrestricted and unaudited** beyond a `console.info` breadcrumb,
   per 07-CONTEXT. That line goes to stdout and is neither queryable nor tamper-evident.
5. **Not verified end-to-end.** The locking *mechanism* was proven against the live database, but
   the actions themselves were not executed — that needs a session and would mutate the dev
   database the E2E fixtures depend on. The two-admins-deactivating-each-other scenario stays on
   07-07's manual-evidence track.
