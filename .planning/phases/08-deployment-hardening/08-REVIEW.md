# Phase 8: Deployment Hardening — Review Summary

## Result: PASSED

**Cycles used**: 4 review cycles (the limit is 3; the fourth was authorised by the user
as a documentation-only pass after cycle 3 closed the last code blocker)
**Reviewers**: security-engineer, qa-verification-specialist, infrastructure-devops-engineer
(cycles 1–3); qa-verification-specialist, infrastructure-devops-engineer, technical-writer
(cycle 4, documentation lenses)
**Completed**: 2026-09-16
**Final commit**: `54ff304`

Final state: `npx tsc --noEmit` exit 0, `npm run lint` 0 errors (1 pre-existing warning in
`e2e/sla-tracking.spec.ts`, untouched by this phase), `npm run build` succeeds,
`docker compose config` valid with and without the `email` profile, `caddy validate` reports
`Valid configuration`, all intra-document links in `DEPLOYMENT.md` resolve, working tree clean.

## Findings summary

| | Found | Resolved | Deferred |
|---|---|---|---|
| BLOCKER | 11 | 11 | 0 |
| WARNING | ~38 | ~36 | 2 |
| SUGGESTION | ~25 | the material ones | rest recorded |

Per cycle, all three reviewers returned NEEDS WORK in cycles 1–4; the phase passes on the
cycle-4 fixes being verified by direct measurement rather than on a clean reviewer verdict.
That distinction is stated plainly in "Why this passes" below.

## The blockers, and what they actually were

| # | Cycle | Issue | Resolution |
|---|---|---|---|
| 1 | 1 | **`db:seed` could write a published-password admin to production.** Five demo accounts sharing `Password123!`, behind a guard gated on `NODE_ENV=production` — which is unset for host-side tooling, so the guard was structurally unable to fire. | `assertSeedingIsIntended()` requires an exact `ALLOW_DEMO_SEED=true`; `ALLOW_SEED_IN_PRODUCTION` is no longer read at all. Gate tested across 8 opt-in values. |
| 2 | 1 | **`psql` missing from prerequisites.** `post-migrate.sh` shells out to it; without it step 1 succeeds and step 2 dies at `psql: command not found`, silently omitting the one-active-timer partial index. | Prerequisite added with apt/dnf/brew lines and the asymmetric-failure explanation. Full chain executed. |
| 3 | 1 | **Five QBO/crypto env vars never reached the `app` container.** Compose's `.env` is interpolation-only and `.dockerignore` excludes `.env` from the build context, so `src/lib/qbo.ts` and `src/lib/crypto.ts` read `undefined` regardless of what the operator filled in. | Enumerated in `app.environment` as bare keys. Read back out of a running container. |
| 4 | 1 | **No `log` directive in the `Caddyfile`.** The runbook's docker-proxy lockout check reads `remote_ip` from the access log; with no `log`, it produced no output and read as "nothing wrong". | `log` added; 8 access-log lines with `remote_ip` produced from the shipped config. |
| 5 | 1 | **`AUTH_URL` pre-filled in `.env.example`**, defeating the `${AUTH_URL:?}` guard it was paired with. | Ships blank, like the other three fail-fast credentials. |
| 6 | 2 | **The partial-index verification command had zero signal.** `\di+ TimeEntry_one_active_timer_per_user` — psql down-cases an unquoted `\d` pattern, so it searched for `timeentry_…` and could never match. Verified against Postgres 16 with the index present and then dropped: byte-identical `Did not find any relation` and exit 0 both times, confirmed by `diff`. The doc then said "no rows means it is missing" and sent the operator to re-run a migration that had already succeeded — a correct deployment read as broken, indefinitely. | Replaced with a `pg_indexes` query. Verified to print the name when present and nothing when absent. |
| 7 | 3 | **`AUTH_SECRET_1..3` reached the container and were then discarded.** `next-auth/lib/env.js:22` assigns `config.secret` as a string before `@auth/core`'s rotation block, which is gated behind `if (!config.secret?.length)` — a non-empty string has truthy `.length`, so the slots were never read. The documented rotation logged every user out. Failed closed, so availability and doc accuracy rather than an auth bypass. | New `src/lib/auth-secrets.ts`, one ordered list consumed by `src/auth.config.ts` and `src/lib/session.ts`. Closed end to end: real Postgres, real migrations, seeded admin, credentials sign-in, three genuine process restarts — old cookie survives the rotation, control without the slot invalidates it. |
| 8 | 4 | **The rate-limit tuning check could not work.** `curl http://127.0.0.1/` is answered 308 by Caddy's auto-HTTPS redirect vhost. Measured: that request *and* the same one carrying `Host: $SITE_ADDRESS` both return 308 and **neither reaches `app`**, so the lazily-instantiated proxy module never loaded and the grep was always empty — producing exactly the false clean the surrounding paragraph warns about, with a command that looked like it discharged the obligation. | HTTPS request to the site's own hostname, with the reason stated so it does not get "fixed" back. |
| 9 | 4 | **`docker compose restart app` does not rotate a secret.** Measured: `restart` reuses the container, environment is fixed at create time, the old secret survives while Compose prints `Started` and exits 0. The documented success criterion — nobody logged out — is also what a no-op looks like. The operator then drops `AUTH_SECRET_1` on schedule and the next unrelated recreate logs everyone out, with the compromised secret live throughout. | `docker compose up -d app`, its own findable section, a verification step, and the caveat added to the stop/restart block an operator reaches first. |
| 10 | 4 | **The cookie-name check tested nothing it claimed to.** `DEPLOYMENT.md` called it "the only end-to-end confirmation" that `AUTH_URL` is https. Pinning `useSecureCookies` in production (the cycle-3 fix) made it incapable of failing. Measured, both arms byte-identical: `https://` and `http://` each return 302 and set `__Secure-authjs.session-token` with the `Secure` attribute. It confirms `NODE_ENV`, not `AUTH_URL` — the same defect this document condemns elsewhere. | Rewritten to say what it does test. The `[proxy]` log line is documented as the only `AUTH_URL` detector. |
| 11 | 4 | **`.planning/CODEBASE.md` described the pre-Phase-8 world** in a file updated during Phase 8: `app` publishes 3000 with no reverse proxy, credentials are `postgres:postgres`, `src/middleware.ts` awaits migration, "ROADMAP Phase 8 owns the real fix" — all marked complete in `ROADMAP.md`. A reader opening the codebase map to ask whether this deployment is safe to expose was told it is not. | Rewritten; closed hotspots recorded rather than deleted. |

## Corrections recorded rather than buried

Five claims made during this phase were wrong and were corrected against measurement. They
are listed because each was believed, written down, and in three cases shipped.

1. **"`reverse_proxy` appends `X-Forwarded-For`."** Wrong. Live test: bare `reverse_proxy`
   **drops** a forged XFF; adding `trusted_proxies 0.0.0.0/0` makes it append with the forged
   value **first**; `header_up` drops it unconditionally. The `Caddyfile` comment and
   `DEPLOYMENT.md` were rewritten around the measured behaviour, which is *why* the
   `header_up` line is load-bearing.

2. **The cycle-2 profile matrix disagreement.** The security and infrastructure reviewers
   measured `docker compose stop`/`down` under profiles and reported opposite results. Cause:
   the infrastructure reviewer passed `-p <project>` for isolation, and that flag silently
   changes the behaviour under test. Adjudicated by re-measurement: without `-p`,
   `stop`/`down`/`restart` **exclude** the profiled service and `down` leaves a credentialed
   poller running while exiting 0. The runbook's own commands never pass `-p`, so that is the
   operator-facing reality. The infrastructure reviewer retracted its table in cycle 3.
   `COMPOSE_PROJECT_NAME` does **not** behave like `-p` — a claim introduced in the cycle-3
   fix and falsified in cycle 4.

3. **The restore lock rationale.** Shipped as "one idle `app` container holding an
   `AccessShareLock` blocks the restore". An idle backend holds no relation locks: measured,
   `pg_stat_activity.state='idle'` shows zero locks and the restore completes in about a
   second. What blocks it is any session left `idle in transaction`. The instruction
   (`stop app` first) was right; the reason was not, and a wrong reason invites someone to
   test it, watch the restore succeed, and skip the step.

4. **"`[proxy]` warnings are emitted at process start."** They are lazy. Measured on Next
   16.3.3: `next start` reaches Ready with no `[proxy]` line; the warnings appear after the
   first request and never again. The cycle-4 refinement "first *matched* request" is also
   wrong — `GET /favicon.ico`, explicitly excluded by the matcher, instantiates the module.
   The trigger is the first request Next routes through its pipeline.

5. **"A mistyped `http://` `AUTH_URL` makes login fail closed."** Wrong, and it was in five
   places including the warning string itself. Login succeeds; see blocker 10.

One further correction belongs to a reviewer: the cycle-2 evidence reviewer's finding that
`08-02-SUMMARY.md`'s scope line was "not produced by any listed command" was itself wrong —
`08-02-PLAN.md:229` is exactly that command, in a task-level `<verify>` block. It corrected
itself in cycle 3.

## Reviewer verdicts

| Cycle | Security | Evidence / QA | Operability |
|---|---|---|---|
| 1 | NEEDS WORK | NEEDS WORK | NEEDS WORK |
| 2 | NEEDS WORK (0 blockers) | NEEDS WORK (0 blockers) | NEEDS WORK (1 blocker) |
| 3 | NEEDS WORK (0 blockers) | NEEDS WORK (1 blocker) | NEEDS WORK (2 blockers) |
| 4 | — (coherence lens: NEEDS WORK, 3 blockers) | NEEDS WORK (2 blockers) | NEEDS WORK (2 blockers) |

Cycle-4 claim tally: **81 claims checked, 64 held**. Cycle-2: 58 checked, 50 held.

## What the review process itself is evidence of

**Every cycle's fixes introduced defects the next cycle caught.** Cycle 2 fixed cycle 1 and
created the inverted index check. Cycle 3 fixed that and created the `COMPOSE_PROJECT_NAME`
error and the unworkable tuning check. Cycle 4 fixed those, and its own first batch created
the two blockers its second batch closed. The rate fell — cycle 4's findings were
contradictions and sweep gaps, not wrong measurements — but it never reached zero.

Two structural lessons, recorded because they are cheap to act on next phase:

- **A statement gets corrected where the grep looked, and survives one line above the
  correction.** Four cycles running. The clearest instance: `src/proxy.ts`'s docstring
  asserted the silent cookie downgrade and "produces no error at all" six lines above the
  warning string that had just been rewritten to say the opposite. Sweeps must be driven from
  a search over the whole tree, not from the files someone remembers — which is how
  `.planning/CODEBASE.md` surfaced, three cycles late.
- **A reviewer's isolation technique can change what it measures.** The `-p` flag cost a
  cycle. Reviewers were told from cycle 3 onward to isolate by directory, not by flag.

**Match the agent's toolset to the brief.** Cycle 3's security reviewer was handed a
"verify by execution" brief and had no shell; it opened its report saying so. Its strongest
finding — blocker 7 — came from reading vendored library source, which no black-box test
would have surfaced. Cycle 4 used that deliberately: a coherence lens with no shell, whose
whole job was reading the prose against itself, found the two worst items of the cycle.

## Deferred, with reasons

| Item | Why deferred |
|---|---|
| **Production image runs as root with the dev toolchain** and `prisma/seed.ts` present | A Dockerfile restructure beyond this phase's remit. Blast-radius reduction, not an exposure: `app` publishes no host port, so reaching it means already being past Caddy or on the Compose network. Recorded as hotspot 2 in `.planning/CODEBASE.md`. |
| **`saveWatermark()` has no `mkdirSync`** | A non-existent `EMAIL_POLLER_STATE_DIR` throws `ENOENT`. Not reachable through Compose — the named volume creates `/state`. |

## Unverifiable in this environment

Stated so nobody reads the runbook as fully observed:

- **Real ACME issuance.** No public DNS. Every TLS observation here comes from Caddy's
  internal CA answering for `localhost`, which exercises none of the ACME path.
  `DEPLOYMENT.md` and the `Caddyfile` both label this NOT VERIFIED.
- **`docker compose build` of the `app` image.** `npm ci` inside the builder fails with
  `SELF_SIGNED_CERT_IN_CHAIN` against this sandbox's egress proxy. Reviewers substituted the
  repo's own compose file with a stub upstream running the host-built `.next`; the `build`
  row of the profile matrix is therefore untested.

## Why this passes

All 11 blockers are closed and each was verified by execution, not by reviewer report — in
several cases by re-running the reviewer's own measurement and, twice, by finding the
reviewer wrong. The remaining risk is documentation drift rather than defect: cycle 4's
findings were contradictions between sentences, not commands that fail.

It passes on measurement, not on a clean verdict. No cycle ended with a reviewer saying PASS,
and a fifth cycle would likely find something — that is the honest read of the trend above.
The judgement is that the residual is the asymptote of a 700-line operational document rather
than an unclosed defect, and the user made the call to stop here.
