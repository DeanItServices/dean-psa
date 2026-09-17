# Retrospective Log

Retrospective findings from completed phases and milestones.
Referenced by `/legion:plan` for continuous improvement.

## Phase 8: Deployment Hardening — 2026-09-17

Planned 2026-09-15, shipped 2026-09-16 (PR #23). 4 plans, 3 waves, 4 review cycles.

### Key Findings

**Worked**
- **Plan critique is the highest-leverage step available.** Verdict REWORK, 5 CRITICAL, all
  fixed in plan text before execution — base64 passwords breaking the `DATABASE_URL` URI,
  `RATE_LIMIT_*` never reaching the container, `db` port removal with no working replacement,
  nothing mechanically proving the Caddy header landed, and `AUTH_URL`'s http default
  surviving the phase. Five defects that never became code.
- Wave structure with explicit `depends_on` produced zero file conflicts across 4 plans;
  08-02 and 08-03 ran parallel in wave 2. Zero escalations.
- Reviewers retracting their own findings was worth more than any single finding. The
  infrastructure reviewer retracted both its cycle-2 profile matrix and its restore
  rationale; the evidence reviewer retracted a claim about 08-02's scope line.
- A reviewer deliberately given **no shell** (coherence lens, cycle 4) found the two worst
  items of that cycle. Neither was reachable by running a command.

**Didn't work**
- **Every cycle's fixes introduced defects the next cycle caught, and it never reached zero.**
  Cycle 2 created the inverted index check; cycle 3 created the `COMPOSE_PROJECT_NAME` error
  and an unworkable tuning check; cycle 4's first batch created the two blockers its second
  batch closed. Cycle counts are trending up: Phase 6 used 2, Phase 7 used 3+1, Phase 8 used 4.
- **Vacuous checks are this project's most persistent defect class.** They appeared at plan
  critique, survived that sweep into execution (08-CONTEXT.md records the sweep as "not
  exhaustive even there"), shipped as the `\di+` blocker that printed identical output
  whether the index existed or not, and recurred in the coordinator's own verification during
  `/legion:polish`.
- An agent's toolset was mismatched to its brief: a read-only agent type received a
  "verify by execution" brief (cycle 3 security reviewer).
- Stale-text sweeps were driven from memory rather than search. Seed instructions: cycle 1
  fixed one file, cycle 2 found four more, cycle 3 found two more in a file nobody had opened.
- A reviewer's isolation technique changed the system under test — the `-p` flag flips
  Compose's profile behaviour, costing a cycle and producing two reviewers with opposite
  results from real containers.

**Patterns to drop**
- Verification commands with no negative control.
- `file:line` citations across files — one went stale within a single commit.
- Treating "the grep is clean now" as proof a fix is complete. The recurring shape across all
  four cycles was a statement corrected where the grep looked, surviving one line above the
  correction.

### Action Items

| # | Action | Priority | Evidence |
|---|--------|----------|----------|
| 1 | Every verification command must be shown to FAIL on the pre-change tree before the plan is approved; record the negative-control output in the plan | High | `\di+` blocker; 08-02 and 08-04 corrected commands |
| 2 | Check an agent type's tool grants before writing its brief; never send "verify by execution" to a read-only agent | High | Cycle-3 security reviewer |
| 3 | Drive stale-text sweeps from one `grep` over the whole tree; paste the command into the summary | High | 3 consecutive cycles of stale seed instructions |
| 4 | Re-run plan `verification_commands` at the start of every review cycle, not only at build and ship | Medium | 3 stale assertions surviving to the ship gate |
| 5 | Cite symbols, never `file:line`, in cross-file references | Medium | Citation stale within one commit |
| 6 | Reviewer briefs must forbid isolation techniques that alter the system under test; isolate by directory | Medium | `-p` profile-matrix contradiction |
| 7 | For any phase whose output is mostly documentation, add the coherence lens at cycle 1 | Medium | Cycle 4 found 3 blockers that had survived 3 cycles |

### Metrics

- Plans completed: 4/4 (one "Complete with Warnings" — stale plan assertion, since corrected)
- Review cycles: 4 (limit 3; the 4th user-authorised) — **0 of 4 ended with a clean verdict**
- Reviewer passes: 12 · Blockers found and closed: 11 · Escalations: 0
- Claims checked: 81 (cycle 4, 64 held) + 58 (cycle 2, 50 held)
- Agents used: 3 — engineering-backend-architect, engineering-security-engineer,
  engineering-infrastructure-devops
- Files modified: 17 source/config (+22 planning artifacts)

**The number that matters most:** the phase passed with zero cycles ending in a clean
reviewer verdict. It passed because every blocker was independently verified closed by
execution, not because a reviewer signed off. That is a legitimate basis, but a different one
than Phases 6 and 7 had. Action items 1-3 are the ones most likely to change it.

---
