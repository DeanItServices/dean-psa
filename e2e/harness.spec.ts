import { test, expect } from "@playwright/test";
import { parseActionResult } from "./actions";
import { SEEDED_FIXTURES, describeEntryDrift, type FixtureSnapshot } from "./db";

/**
 * E2E spec: the SUITE'S OWN machinery, where getting it wrong is silent.
 *
 * Two helpers in this directory decide what the other specs are allowed to
 * conclude, and both used to fail by returning a plausible answer rather than
 * by raising:
 *
 *   - parseActionResult (e2e/actions.ts) picked the LAST frame in a flight
 *     stream that looked like an action return. Any re-rendered prop or
 *     error-boundary payload carrying `error`, `success` or `tempPassword`
 *     could shadow the real value, and the run would then fail at an assertion
 *     about a refusal message with nothing anywhere naming the parser.
 *   - the seeded-fixture guard could only diff a run against itself, so drift
 *     that was already present at setup compared equal forever. describeEntryDrift
 *     (e2e/db.ts) is what states the inherited state instead.
 *
 * Both are now exercised against inputs constructed here, because the failure
 * modes are ones the current build does not produce -- which is precisely why
 * they went unnoticed. A test that can only use today's real responses cannot
 * tell a parser that is right from one that is lucky.
 *
 * Tagged @user-lifecycle: these guard the gate's own instruments, so they
 * belong to the same run.
 */

// ---------------------------------------------------------------------------
// parseActionResult
// ---------------------------------------------------------------------------

/** Next's own first frame, as observed on this build (see e2e/actions.ts). */
const ENVELOPE = '0:{"a":"$@1","f":"","b":"development"}';

test.describe("@user-lifecycle e2e harness: parseActionResult", () => {
  test("returns the action's own frame and ignores Next's envelope", () => {
    const raw = [ENVELOPE, '1:{"error":"You cannot deactivate your own account."}', ""].join("\n");

    expect(parseActionResult(raw)).toEqual({
      error: "You cannot deactivate your own account.",
    });
  });

  test("returns null when the reply carries no action result, as a redirect does", () => {
    // A redirect's body is a full page re-render: framed lines, none of which
    // is an action return. Callers assert on `redirectedTo` in that case, so
    // null must stay a normal answer rather than becoming a failure.
    const raw = [
      ENVELOPE,
      '1:["$","div",null,{"children":"change your password"}]',
      "2:HL[\"/_next/static/css/app.css\",\"style\"]",
      "",
    ].join("\n");

    expect(parseActionResult(raw)).toBeNull();
  });

  test("FAILS LOUDLY when a second frame could be mistaken for the action's result", () => {
    // THE REGRESSION THIS FILE EXISTS FOR. Under the previous last-wins rule
    // this returned the SECOND object and the suite went on to assert against
    // it -- reporting a wrong refusal message as a broken guard rail.
    const raw = [
      ENVELOPE,
      '1:{"error":"You cannot deactivate your own account."}',
      '2:{"error":"a re-rendered component prop that happens to be called error"}',
      "",
    ].join("\n");

    let thrown: unknown = null;
    try {
      parseActionResult(raw);
    } catch (error) {
      thrown = error;
    }

    expect(thrown, "an ambiguous stream must not resolve to a guess").not.toBeNull();
    // The message has to carry the candidates, or the next reader is back to
    // guessing which frame was taken.
    expect(String(thrown)).toContain("more than one frame");
    expect(String(thrown)).toContain("a re-rendered component prop");
    expect(String(thrown)).toContain("You cannot deactivate your own account.");
  });

  test("a tempPassword result is recognised, and non-object frames are not", () => {
    const raw = [
      ENVELOPE,
      "1:I[\"[project]/src/components/admin/user-create-form.tsx\",[],\"\"]",
      '2:["$","form",null,{}]',
      '3:{"success":true,"tempPassword":"a-generated-value"}',
      "",
    ].join("\n");

    expect(parseActionResult(raw)).toEqual({
      success: true,
      tempPassword: "a-generated-value",
    });
  });
});

// ---------------------------------------------------------------------------
// describeEntryDrift
// ---------------------------------------------------------------------------

/** A snapshot of the five fixtures exactly as prisma/seed.ts leaves them. */
function pristineSnapshot(): FixtureSnapshot {
  const snapshot: FixtureSnapshot = {};
  for (const { email, role } of SEEDED_FIXTURES) {
    snapshot[email] = {
      role,
      isActive: true,
      mustChangePassword: false,
      tokenVersion: 0,
      hasPassword: true,
    };
  }
  return snapshot;
}

test.describe("@user-lifecycle e2e harness: seeded-fixture entry drift", () => {
  test("a freshly seeded database reports no drift", () => {
    expect(describeEntryDrift(pristineSnapshot())).toEqual([]);
  });

  test("a tokenVersion that moved before the run is reported, with both values", () => {
    // The real case: admin@mspdemo.local sat at tokenVersion 1 while the other
    // four were at 0, and the end-state diff could never see it because the
    // diff's baseline IS that state. There is deliberately no absolute
    // invariant for this column -- a password change legitimately increments
    // it -- so being told is the whole remedy.
    const snapshot = pristineSnapshot();
    snapshot["admin@mspdemo.local"]!.tokenVersion = 1;

    const drift = describeEntryDrift(snapshot);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("admin@mspdemo.local");
    expect(drift[0]).toContain("tokenVersion is 1");
    expect(drift[0]).toContain("the seed leaves 0");
  });

  test("every field the seed writes is compared, not just the flags", () => {
    const snapshot = pristineSnapshot();
    snapshot["technician@mspdemo.local"]!.role = "admin";
    snapshot["dispatcher@mspdemo.local"]!.isActive = false;
    snapshot["sales@mspdemo.local"]!.mustChangePassword = true;
    snapshot["finance@mspdemo.local"]!.hasPassword = false;

    const drift = describeEntryDrift(snapshot);
    expect(drift).toHaveLength(4);
    expect(drift.join("\n")).toContain("technician@mspdemo.local: role is admin");
    expect(drift.join("\n")).toContain("dispatcher@mspdemo.local: isActive is false");
    expect(drift.join("\n")).toContain("sales@mspdemo.local: mustChangePassword is true");
    expect(drift.join("\n")).toContain("finance@mspdemo.local: hasPassword is false");
  });

  test("a fixture that is missing entirely is reported rather than skipped", () => {
    const snapshot = pristineSnapshot();
    delete snapshot["admin@mspdemo.local"];

    const drift = describeEntryDrift(snapshot);
    expect(drift).toEqual(["admin@mspdemo.local: absent from the database at setup."]);
  });
});
