# Plan 08-04 — Trust Boundary + Runbook — SUMMARY

**Status**: Complete
**Wave**: 3
**Agent**: engineering-infrastructure-devops + engineering-security-engineer
**Date**: 2026-09-16
**Requirements**: `getClientIp()` trust-boundary warning says the boundary is enforced; `DEPLOYMENT.md` reflects the new topology including the `POSTGRES_PASSWORD` initdb caveat and `ALTER USER`

## Files

| File | Change |
|------|--------|
| `src/proxy.ts` | **Comments only.** Trust-boundary block rewritten (exposure → what closed it → three conditions that carry it → what is still true), plus the rate-limiter header note, the null-branch comment, and 08-02's flagged "thresholds are fixed" wording. |
| `DEPLOYMENT.md` | Rewritten for the Caddy topology; onboarding precondition retracted; new sections for password rotation, TLS-on-first-request, Intuit re-registration, session logout, and the `set -a` prerequisite. +147/−24. |

**Comments-only claim verified independently** by the coordinator with a comment/string-aware
stripper: with comments and comment-like string content removed, the remaining executable text
is **byte-identical to HEAD**. No line count is quoted here — the count depends entirely on the
stripper's rules (whether blank lines and brace-only lines survive), and an independent reviewer's
stripper produced a different number from the same file while confirming the same byte-identity.
The reproducible form of the claim is the identity, not a tally. `tsc --noEmit` and `lint` both 0.

Reproduce the diffstat above with:

```
$ git diff --numstat 84a5332..ff45331 -- DEPLOYMENT.md src/proxy.ts
147	24	DEPLOYMENT.md
102	53	src/proxy.ts
```

`src/proxy.ts`'s 102/53 is comment churn; the executable text is unchanged.

## Claim strength — the comment matches the evidence, not P8-5's wording

P8-5 says "Caddy **overwrites** `X-Forwarded-For`". That premise is **imprecise**, and the
comment deliberately does not repeat it. Verified live (twice — by 08-03 and re-derived
first-hand by this executor) against `caddy:alpine v2.11.4`:

| Config | Upstream saw |
|--------|-------------|
| bare `reverse_proxy` (default) | `172.18.0.1` — forged chain **dropped**, not overwritten |
| `+ trusted_proxies 0.0.0.0/0` | `66.66.66.66, 7.7.7.7, 172.18.0.1` — forged value **first** |
| shipped `Caddyfile` | `172.18.0.1` — dropped unconditionally |

Caddy's default is safe but **conditional** on no `trusted_proxies` range covering the peer.
The comment attributes the guarantee to the `header_up` directive this repo ships — which
removes the condition — rather than to the default, so the directive does not read as
deletable. P8-5's *end state* (boundary enforced) is satisfied; its stated *mechanism* was
not accurate.

The comment does **not** claim the boundary is solved. It names three conditions, each
framed as a way to lose it:

1. Caddy stays the only ingress (re-publishing `app:3000` restores the original exposure).
2. The `header_up` line stays in the `Caddyfile`.
3. The Docker daemon preserves source addresses — under the userland `docker-proxy` every
   request appears to come from the bridge gateway, which **turns the limiter into a lockout**
   affecting staff and attacker alike, not merely a weakened control.

And it preserves what is still true: `rateLimitStore` is per-process and in-memory — a
brute-force speed bump, not a distributed limiter.

## NEW FINDING — `X-Real-IP` is not overwritten

Discovered by the executor during its own re-verification, **independently reproduced by the
coordinator** against the shipped `Caddyfile`:

```
sent: X-Forwarded-For: 66.66.66.66  +  X-Real-IP: 66.66.66.66
saw:  XFF=[172.18.0.1]   XRI=[66.66.66.66]
```

The `Caddyfile` sets `header_up` for `X-Forwarded-For` **only**. A forged `X-Real-IP`
reaches the application unmodified.

**Not exploitable today**: `getClientIp()` reads `x-forwarded-for` first
(`src/proxy.ts`, line 2 of the function) and Caddy sets it on every proxied request, so the
`x-real-ip` branch is unreachable in the shipped topology. Confirmed by reading the source.

**But the boundary now partly rests on the order of two checks in application code**, not on
the Caddy directive alone. The comment says so explicitly and forbids reordering or
collapsing them into a first-non-empty lookup. The clean fix is a second
`header_up X-Real-IP {remote_host}` line — in `Caddyfile`, which 08-03 owns and which was
forbidden to this plan. **Carried forward as a recommended follow-up.**

## `caddy validate` actively advises deleting the load-bearing directive

```
Unnecessary header_up X-Forwarded-For: the reverse proxy's default behavior is to pass headers to the upstream
```

The lint heuristic is wrong here — it assumes the unconditional default. This is the most
likely route to someone removing the line, so it is countered in `DEPLOYMENT.md` with the
counter-evidence. The `Caddyfile`'s own comment does not name the warning; a one-line
addition there would help and is likewise 08-03's file.

## DEPLOYMENT.md — 12 areas rewritten

Network/firewall (four-service published-ports table; `app` none, `db` `127.0.0.1`), the
rate-limiting paragraph (now names `src/proxy.ts`, documents the three `RATE_LIMIT_*`
overrides, adds the `docker-proxy` post-go-live check), prerequisites (public DNS + ACME
egress), env groups (`POSTGRES_PASSWORD` with hex generation and the asymmetric-failure
warning, `SITE_ADDRESS`, `HTTP_PORT`/`HTTPS_PORT`, `AUTH_URL` required-and-https), QuickBooks
(Intuit re-registration), build/start (four services, fail-fast explanation, **new** TLS-on-
first-request subsection, no-`restart:`-policy note), migrations (**`set -a` prerequisite**
plus a blockquote recording that `docker compose exec app npm run db:migrate:deploy` does
**not** work — verified against `package.json:11`, `scripts/post-migrate.sh:1,52`), **new**
password-rotation section (`ALTER USER`, plus the safer interactive `\password` since the
scripted form leaks to shell history and `ps`), the retracted onboarding precondition,
`DB_PORT`, and the `:274` tuning note.

Sweeps clean: no `src/middleware.ts`, no `Phase 8: revisit`, no "do not create accounts for
the team".

## End-to-end — partially executed, honestly reported

**`docker compose up -d` was NOT run** (the `app` image build is `npm ci` + `next build`),
and **the cookie-name check was NOT executed** — no built image, no public DNS, no issuable
certificate. The plan's `<output>` asks for the observed cookie name; the accurate answer at
the time was **not executed**.

> **Resolved in review cycle 4, and the check turned out to be the wrong check.** It was
> executed against a production build: the cookie is `__Secure-authjs.session-token`. But it
> is that in **both** arms — a correct `https://` `AUTH_URL` and a mistyped `http://` one
> each return 302 and set the same `__Secure-` cookie — because `src/auth.config.ts` pins
> `useSecureCookies` under `NODE_ENV=production`, so the URL's protocol is never consulted.
> The check confirms `NODE_ENV`, not `AUTH_URL`. `DEPLOYMENT.md` and `.env.example` were
> corrected accordingly; the `[proxy] AUTH_URL uses http://` log line is the only detector.

What *was* run, against the real `Caddyfile` mounted read-only:

- `caddy validate` → `Valid configuration`, exit 0
- **HTTP→HTTPS redirect, live**: `HTTP/1.1 308 Permanent Redirect`, `Location: https://localhost/`,
  with `"certificate obtained successfully","issuer":"local"` (internal CA, not ACME). Redirect
  behaviour confirmed; a publicly trusted certificate was not and could not be.
- The three-row forged-header experiment, plus the `X-Real-IP` case above.

All test containers and networks removed; `docker ps -a` empty.

## Verification

17 commands, 17 passed, 0 failed, no retries. Both stop gates cleared: `08-03-SUMMARY.md`
records a verified finding, and `grep -qE 'header_up +X-Forwarded-For' Caddyfile` exits 0
against the actual config.

## Carried forward past Phase 8

| Item | Why it is unowned |
|------|-------------------|
| **`header_up X-Real-IP {remote_host}`** | One-line defense-in-depth in `Caddyfile`; 08-03 owns that file |
| **Cookie-name check never observed** | Needs a real deployment with public DNS. **Still unexecuted as of review cycle 2** — no execution has been added, so the `AUTH_URL`/`__Secure-` cookie-prefix failure mode in the spec remains asserted, not observed. |
| **`08-02-PLAN.md` has no scope check** | **Corrected — this finding was wrong.** It is true that 08-02's plan-level `<verification>` block contains no scope assertion (it runs `tsc`, `lint` and five greps). It is **not** true that no listed command produced the scope line: `08-02-PLAN.md:229` is exactly that command, inside the final `<task>`'s `<verify>` block —

```
git status --porcelain | awk '{print $2}' | grep -qvE '^(src/proxy\.ts)$' && { echo "SCOPE VIOLATION"; exit 1; } || echo "scope ok"
```

— so `08-02-SUMMARY.md:28`'s `scope: only src/proxy.ts` is command-backed after all, and independently corroborated by `git show --stat 6185bd4`. The original finding searched only the plan-level block and missed the task-level one. What survives is a much smaller note: scope assertions live in different places across the Phase 8 plans, and the `git status --porcelain` form passes vacuously on a clean tree (see `08-03-SUMMARY.md`), so the line is weaker evidence than it looks — but it is not unverified. |
| `src/lib/session.ts:166` "never from Edge middleware" | Wrong since 08-01; `src/lib/**` forbidden to every Phase 8 plan |
| `e2e/fixtures.ts:42,46` reference deleted `src/middleware.ts` | `e2e/**` forbidden phase-wide |
| `caddy:alpine` floating tag | Verified twice against v2.11.4; pinning a digest is a follow-up |
| No `restart:` policies | Now documented as an explicit operator decision rather than silently absent |

## Errors

None.
