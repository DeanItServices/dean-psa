# Plan 08-02 — Env-Configurable Rate Limits — SUMMARY

**Status**: Complete
**Wave**: 2
**Agent**: engineering-backend-architect + engineering-security-engineer
**Date**: 2026-09-16
**Requirements**: Rate-limit window and thresholds read from `process.env` with 60s/60/10 defaults, genuinely runtime-read now that the file is Node-runtime

## Files

| File | Change |
|------|--------|
| `src/proxy.ts` | Added module-private `envInt()`; `RATE_LIMIT_WINDOW_MS` / `GENERAL_RATE_LIMIT` / `AUTH_RATE_LIMIT` sourced through it with `60_000 / 60 / 10` defaults, plus a comment recording the process-start read and the fail-safe contract. |

Nothing else changed. Code-only diff (comments stripped), reproduced independently by the
coordinator, is exactly three literals replaced by the helper and three `envInt` calls.

## Verification

20/20 commands passed, 0 failed, no retries. Coordinator re-ran independently:

```
npx tsc --noEmit                       -> 0
npm run lint                           -> 0
grep 'process.env['                    -> 0
grep '"RATE_LIMIT_WINDOW_MS|GENERAL|AUTH"' -> 0
matcher byte-identical                 -> 0
scope: only src/proxy.ts
```

Trust-boundary block **39 lines, identical** (08-04's to change). `config.matcher`
byte-identical. `envInt` is not exported — the file still exports only `proxy` and `config`.

## Parser behaviour — independently re-verified

The coordinator extracted `envInt` from the **shipped source** and exercised it directly,
rather than accepting the executor's table:

| Input | Result | Warned |
|-------|--------|--------|
| unset | 10 (default) | no |
| `"3"` | 3 | no |
| `"abc"` | 10 | yes |
| **`"0"`** | **10 — falls back, NOT disabled** | yes |
| `"-5"` | 10 | yes |
| `"1.5"` | 10 | yes |
| `""` | 10 | yes |
| `"60abc"` | 10 | yes |
| `"600000"` | 600000 (no upper bound) | no |

The `0` case is the security-critical one: a typo must not be able to mean "limit
disabled". It falls back and warns.

## End-to-end verification — performed against a running server

The executor ran `next dev` on port 3100 and drove real requests. Reported observations:

| Case | Observed |
|------|----------|
| `RATE_LIMIT_AUTH=3`, POST `/login` ×6 | #1-3 → 200, **#4 → 429** `Retry-After: 56` |
| control: different `X-Forwarded-For` | 200 — per-IP keying intact |
| control: **GET** `/login` ×6 | all 200 — GET stays on the general bucket; the POST classification is unchanged |
| `RATE_LIMIT_AUTH=abc` ×12 | first 429 at #11 — falls back to exactly 10, one warning logged |
| **`RATE_LIMIT_AUTH=0` ×12** | first 429 at #11 — **not disabled** (#11 refused) and **not "nothing allowed"** (#1 permitted) |
| nothing set, POST `/login` | first 429 at #11 → auth default genuinely 10 |
| nothing set, GET `/unauthorized` | first 429 at #61 → general default genuinely 60 |
| nothing set | **0** `[proxy]` log lines |
| `RATE_LIMIT_GENERAL=3` + `RATE_LIMIT_WINDOW_MS=5000` | 4th GET → 429 `Retry-After: 5`; allowed again 6s later — the window variable is wired too |

Defaults reproduce today's behaviour exactly, confirmed live rather than inferred.

## Key implementation decision — plan text was self-inconsistent

The plan's Task 1 prescribed `Number.parseInt` plus a "finite integer > 0" check. That
alone accepts `"1.5"` as `1` and `"60abc"` as `60` — contradicting the plan's **own**
edge-case table, which requires `1.5` to fall back. The executor added a `/^\d+$/` gate on
the trimmed value *before* parsing and resolved in favour of the table. Correct call;
the plan text should be corrected if reused.

Also: `Number.isSafeInteger` rather than `Number.isInteger`, so a value past 2^53 falls
back instead of silently not being the number the operator typed.

Unset is silent; empty warns. An operator who set the variable *somewhere* and got default
behaviour must not be left guessing, while the documented default path stays quiet.

## Carried forward — 08-03 dependency

`src/proxy.ts` now **reads** the three variables. In the shipped Compose topology those
reads are `undefined` until **08-03 enumerates all three under `app.environment`** —
Compose's `.env` interpolates the compose file only and never reaches the container.
Without that, the control silently stays at its defaults: correct and safe, but not
tunable. 08-04 should verify the pair end to end.

**Operational note for 08-03, learned from the live runs.** Use the **list form**
(`environment: [- RATE_LIMIT_AUTH]`, key only), which Compose omits entirely when the host
variable is unset. The mapping form `RATE_LIMIT_AUTH: ${RATE_LIMIT_AUTH}` passes an **empty
string** into the container when unset — and empty is a *rejected* value here, so every
default deployment would log three `[proxy] …=""` warnings at every start. An explicit
`${RATE_LIMIT_AUTH:-10}` default would also work.

## Issues

- Plan text vs its own edge-case table, resolved above.
- `src/proxy.ts:51-57` still describes the thresholds as fixed values. Accurate as
  *defaults*, but no longer the only possible values — a natural touch-up during 08-04's
  pass over this file.
- `DEPLOYMENT.md:274` calls the values hardcoded; already assigned to 08-04.
- Pre-existing lint warning `e2e/sla-tracking.spec.ts:48`; lint still exits 0.

## Errors

None.
