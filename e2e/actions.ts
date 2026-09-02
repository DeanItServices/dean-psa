import { expect, type BrowserContext, type Page, type Request } from "@playwright/test";
import { clientHeaders } from "./fixtures";
import { E2E_BASE_URL } from "./target";

/**
 * CALLING A SERVER ACTION DIRECTLY, OVER THE WIRE.
 *
 * WHY THIS MODULE EXISTS AT ALL. Three of Phase 7's load-bearing guarantees
 * cannot be reached through the UI, by design:
 *
 *   1. THE SELF-TARGET REFUSALS. 07-05's row controls no longer merely disable
 *      themselves on your own row -- they carry aria-disabled, every handler
 *      returns early, and the confirmation dialogs are controlled so a blocked
 *      trigger cannot open one. That is the right accessibility answer, and it
 *      means no sequence of clicks can make the browser send the request. The
 *      refusals in src/lib/actions/users.ts are still the actual boundary, and
 *      the previous spec's technique for reaching them (invoking the React
 *      fiber's onClick past a `disabled` attribute) now invokes a handler that
 *      returns early -- it proves the client guard, not the server one.
 *   2. THE mustChangePassword BOUNDARY. requireRole() is what makes every
 *      Server Action module unreachable while that flag is set, and the
 *      (dashboard) layout's own comment says its matching redirect "is UX, NOT
 *      the security boundary". A test that navigates to dashboard routes and
 *      observes /change-password passes identically if requireRole()'s check is
 *      deleted. Only an actual action invocation distinguishes them.
 *   3. SERVER-SIDE VALIDATION THE FORM PREVENTS YOU FROM SUBMITTING.
 *      /change-password's inputs carry `required` and `minLength`, so the
 *      browser refuses to submit the very inputs the server-side floors exist
 *      to reject.
 *
 * HOW IT WORKS, AND WHY NOTHING IS HARDCODED. A Server Action is addressed by
 * an opaque id that Next.js generates at build time and sends in the
 * `Next-Action` request header; the arguments are the request body. Both were
 * established empirically against this build rather than from documentation:
 *
 *   POST <the page's own URL>
 *   Next-Action: 4082c21b1f7946bfe9653e65617e474cfae4e66fe0
 *   Content-Type: text/plain;charset=UTF-8
 *   Accept: text/x-component
 *   ["cmtkj2pxx0001utsym4y1v8f4"]
 *
 * and the reply is an RSC flight stream whose last framed line is the action's
 * own return value:
 *
 *   1:{"error":"You cannot deactivate your own account. ..."}
 *
 * A `redirect()` thrown inside the action instead surfaces as an
 * `x-action-redirect: /change-password;push` response header with a full
 * re-render as the body.
 *
 * THE ID IS NEVER WRITTEN DOWN. It changes with every build, so hardcoding one
 * would produce a spec that silently stops exercising anything the next time
 * the app is rebuilt. `captureActionCall` observes a REAL invocation the test
 * was performing anyway -- an admin acting on a throwaway account -- and reuses
 * that id and body shape. If the capture sees nothing, the helper fails loudly
 * rather than proceeding with an empty id.
 *
 * WHAT THIS IS NOT. It is not a way to bypass authorization: every call carries
 * the browser context's own cookies, so the server sees exactly the session the
 * test logged in as. It is the same request the page would have sent if the
 * client-side guard were absent -- which is precisely the attacker the
 * server-side refusals exist for.
 */

export type ActionCall = {
  /** The opaque per-build Server Action id, from the Next-Action header. */
  id: string;
  /** The request body exactly as the browser sent it. */
  body: string;
  /** text/plain for plain arguments, multipart/form-data when a FormData is passed. */
  contentType: string;
};

export type ActionResponse = {
  status: number;
  /** Path from `x-action-redirect`, with Next's ";push"/";replace" suffix removed. */
  redirectedTo: string | null;
  /** The action's own return value, parsed out of the flight stream. */
  result: Record<string, unknown> | null;
  raw: string;
};

/**
 * Runs `run` and returns the Server Action call the page made while it ran.
 *
 * The last one, if several: the helpers below drive one control at a time, and
 * taking the last means a background prefetch or revalidation cannot shadow the
 * call under observation.
 */
export async function captureActionCall(
  page: Page,
  run: () => Promise<void>,
): Promise<ActionCall> {
  const seen: ActionCall[] = [];

  const onRequest = (request: Request) => {
    const headers = request.headers();
    const id = headers["next-action"];
    if (request.method() !== "POST" || !id) {
      return;
    }
    seen.push({
      id,
      body: request.postData() ?? "",
      contentType: headers["content-type"] ?? "text/plain;charset=UTF-8",
    });
  };

  page.on("request", onRequest);
  try {
    await run();
    await expect
      .poll(() => seen.length, {
        message:
          "no Server Action request was observed while capturing. The action id is read " +
          "off a real invocation because it changes with every build; without one there " +
          "is nothing to replay, and silently continuing would test nothing.",
      })
      .toBeGreaterThan(0);
  } finally {
    page.off("request", onRequest);
  }

  return seen[seen.length - 1]!;
}

/** The keys every action return in this codebase is identified by. */
const ACTION_RESULT_KEYS = ["error", "success", "tempPassword"] as const;

/**
 * Pulls the action's return value out of an RSC flight stream.
 *
 * The stream is line-framed as `<id>:<payload>`. This scans every frame for a
 * JSON object carrying one of this codebase's action-return keys and requires
 * there to be EXACTLY ONE. Returns null when there is none, which is the normal
 * shape for a redirect (the body is then a full page re-render) -- callers
 * assert on `redirectedTo` in that case.
 *
 * WHY "EXACTLY ONE" AND NOT "THE LAST ONE". This used to keep the last matching
 * frame, and the comment here argued that taking the last was the safe choice
 * -- reasoning borrowed from captureActionCall above, where "last" genuinely is
 * right because a background prefetch fires BEFORE the call under observation.
 * A flight stream is not a request log and has no such ordering: the frames are
 * the re-rendered tree the reply carries alongside the return value, in
 * whatever order Next serializes them. So any re-rendered component prop, any
 * error-boundary payload or any nested object that happens to carry an `error`,
 * `success` or `tempPassword` key could sit after the real return value and
 * shadow it -- silently, since the parser has no way to know it picked the
 * wrong one.
 *
 * The damage is not a wrong value; it is a wrong DIAGNOSIS. The test then fails
 * at an assertion about a refusal message or a temporary password, pointing at
 * the action or the guard rail under test, with nothing anywhere naming the
 * parser. Someone would "fix" a working guard rail.
 *
 * Failing here instead costs an ambiguous stream a loud, self-describing error
 * naming both candidates. If a legitimate second candidate ever appears, the
 * fix is to frame on the action's own result line (Next's envelope frame `0`
 * references it, e.g. {"a":"$@1",...} -> frame 1) rather than to widen this
 * back to last-wins.
 */
// Exported ONLY so e2e/harness.spec.ts can execute the ambiguity branch
// against a stream it constructs. A real response is the wrong instrument for
// that: the shadowing case is one this build does not currently produce, which
// is exactly why it went unnoticed as a silent wrong answer.
export function parseActionResult(raw: string): Record<string, unknown> | null {
  const candidates: { frame: string; record: Record<string, unknown> }[] = [];

  for (const line of raw.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;

    const payload = line.slice(colon + 1);
    if (!payload.startsWith("{")) continue;

    try {
      const parsed = JSON.parse(payload) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

      const record = parsed as Record<string, unknown>;
      // Next's own envelope frame ({"a":...,"f":...,"b":"development"}) carries
      // none of these keys, so it is skipped without being special-cased.
      if (ACTION_RESULT_KEYS.some((key) => key in record)) {
        candidates.push({ frame: line.slice(0, colon), record });
      }
    } catch {
      // Not a JSON frame -- flight streams carry plenty of those.
    }
  }

  expect(
    candidates.length,
    "the flight stream carried more than one frame that looks like a Server Action " +
      "return value, so which one the action actually returned is a guess. Frames: " +
      candidates.map(({ frame, record }) => `${frame}:${JSON.stringify(record)}`).join("  |  ") +
      ". See parseActionResult in e2e/actions.ts -- do not resolve this by taking " +
      "the last one.",
  ).toBeLessThanOrEqual(1);

  return candidates[0]?.record ?? null;
}

/**
 * Invokes a captured Server Action with a body of the caller's choosing, as the
 * session `context` holds.
 *
 * `path` is the route the action is posted to -- the page it would have been
 * invoked from. It matters because Next re-renders that route into the reply.
 */
export async function invokeAction(
  context: BrowserContext,
  path: string,
  call: ActionCall,
  body: string,
): Promise<ActionResponse> {
  const response = await context.request.post(`${E2E_BASE_URL}${path}`, {
    headers: {
      ...clientHeaders(context),
      "next-action": call.id,
      accept: "text/x-component",
      "content-type": call.contentType,
    },
    data: body,
    maxRedirects: 0,
  });

  const raw = await response.text();
  const redirect = response.headers()["x-action-redirect"];

  return {
    status: response.status(),
    // "/change-password;push" -> "/change-password"
    redirectedTo: redirect ? redirect.split(";")[0]! : null,
    result: parseActionResult(raw),
    raw,
  };
}

/**
 * Re-points a captured single-argument action (deactivateUser, reactivateUser,
 * resetUserPassword -- all `(id: string)`) at a different user id.
 *
 * Asserts the substitution actually happened. A regex that silently matched
 * nothing would replay the ORIGINAL target and pass for the wrong reason, which
 * is the specific failure mode this whole file exists to avoid.
 */
export function retargetUserId(call: ActionCall, userId: string): string {
  const body = JSON.stringify([userId]);

  expect(
    call.body,
    "expected a single-string-argument action body of the form [\"<userId>\"]",
  ).toMatch(/^\["[^"]+"\]$/);

  return body;
}

/**
 * Re-points a captured `updateUserRole(id, formData)` call at a different user
 * AND a different role.
 *
 * The body is multipart, because the second argument is a FormData: Next
 * encodes the positional arguments in a part named "0" (with the FormData
 * standing in as a temporary reference such as `$K1`) and the FormData's own
 * fields in parts named `_1_<field>`. Rather than hand-building that encoding,
 * this edits the real body the browser produced, so the wire format stays
 * whatever the installed Next actually emits.
 *
 * Both substitutions are asserted. Submitting a role the target already holds
 * would make a self-demotion test degenerate -- a regression that narrowed the
 * self-target guard to same-role submissions would leave real self-demotion
 * possible and the test green -- so the caller passes a genuinely different
 * role and this function proves it reached the wire.
 */
export function retargetRoleChange(
  call: ActionCall,
  userId: string,
  role: string,
): string {
  expect(call.contentType, "updateUserRole is called with a FormData").toContain(
    "multipart/form-data",
  );

  const withRole = call.body.replace(
    /(name="_1_role"\r\n\r\n)[^\r]*(\r\n)/,
    `$1${role}$2`,
  );
  expect(withRole, "the multipart body must carry a _1_role part to rewrite").not.toBe(
    call.body,
  );
  expect(withRole).toContain(`name="_1_role"\r\n\r\n${role}\r\n`);

  const withTarget = withRole.replace(/\["[^"]+",("\$K\d+"\])/, `["${userId}",$1`);
  expect(
    withTarget,
    'the multipart body must carry a positional-argument part of the form ["<userId>","$K1"]',
  ).not.toBe(withRole);
  expect(withTarget).toContain(`["${userId}",`);

  return withTarget;
}
