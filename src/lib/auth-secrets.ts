/**
 * The ordered session-signing/decryption secret list, shared by the Auth.js
 * config and by the raw-cookie reader in src/lib/session.ts so both agree on
 * exactly which secrets are live.
 *
 * WHY THIS EXISTS RATHER THAN LETTING AUTH.JS ASSEMBLE IT.
 *
 * @auth/core knows how to build a rotation list from AUTH_SECRET_1..3
 * (node_modules/@auth/core/lib/utils/env.js), but in a next-auth app that code
 * is unreachable. next-auth's own setEnvDefaults runs first and assigns
 * `config.secret` as a STRING:
 *
 *   config.secret ?? (config.secret = process.env.AUTH_SECRET ?? ...)
 *     -- node_modules/next-auth/lib/env.js:22
 *
 * and only then calls core's setEnvDefaults, which gates the whole rotation
 * block behind `if (!config.secret?.length)`. A non-empty string has a
 * truthy .length, so the gate is closed and AUTH_SECRET_1..3 are never read.
 * Verified at runtime against the versions vendored in this repo: with
 * AUTH_SECRET=CURRENT and AUTH_SECRET_1=RETIRED1 set, the next-auth path
 * yields `"CURRENT"` while core called on its own yields
 * `["RETIRED1","CURRENT"]`.
 *
 * So setting `secret` explicitly is not belt-and-braces; it is the only way
 * the rotation slots have any effect on the request gate, signIn or signOut.
 *
 * ORDER IS LOAD-BEARING, AND IT IS NOT UPSTREAM'S ORDER.
 *
 * @auth/core's encode() signs with `secrets[0]` and decode() tries every entry
 * (node_modules/@auth/core/jwt.js:49-84). Core's own assembly pushes
 * AUTH_SECRET then UNSHIFTS 1, 2, 3, which puts the HIGHEST-NUMBERED SLOT at
 * index 0 -- i.e. upstream treats the numbered slots as the active signing
 * secret and AUTH_SECRET as the fallback.
 *
 * This project documents the opposite and safer contract (.env.example,
 * DEPLOYMENT.md): AUTH_SECRET is current and signs; the numbered slots hold
 * RETIRED secrets and are decode-only. Under upstream's order, an operator
 * rotating away from a compromised secret would put it in AUTH_SECRET_1 and
 * the app would start signing new sessions with it. AUTH_SECRET therefore
 * goes first here, deliberately, and the numbered slots follow.
 */
export function authSecrets(): string[] {
  return [
    process.env.AUTH_SECRET,
    process.env.AUTH_SECRET_1,
    process.env.AUTH_SECRET_2,
    process.env.AUTH_SECRET_3,
  ].filter(
    (secret): secret is string =>
      typeof secret === "string" && secret.length > 0,
  );
}
