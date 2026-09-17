import type { NextAuthConfig } from "next-auth";
import { authSecrets } from "@/lib/auth-secrets";

/**
 * Minimal Auth.js base config, kept free of database and crypto dependencies.
 *
 * HISTORY / WHY THE SPLIT STILL EXISTS. This file was originally split out
 * because the request gate ran in the Next.js Edge runtime, where a database
 * adapter, a password-hashing library and a credentials provider that looks
 * up a user row simply could not run. That constraint is gone: the gate is
 * now src/proxy.ts, the Next.js 16 Proxy convention, which runs on the
 * Node.js runtime.
 *
 * The split is KEPT as a deliberate design choice, not a runtime
 * requirement. The proxy answers one coarse question -- "is there a session
 * at all?" -- on every matched request. It has no business importing the
 * Prisma adapter, opening a database connection, or loading bcrypt to do
 * that, and keeping those out of its import graph keeps the per-request cost
 * and the blast radius small. Do not merge this back into the proxy or into
 * src/auth.ts just because Edge no longer forbids it.
 *
 * It is consumed by:
 *  - src/proxy.ts for the coarse "is there a session" check
 *  - src/auth.ts, which spreads this config and adds the credentials
 *    provider and JWT session handling (a Prisma-backed database session
 *    strategy was originally planned but is unsupported by Auth.js v5 for a
 *    Credentials-only provider list -- see src/auth.ts).
 *
 * Do not add providers, adapters, or database/crypto imports here.
 * (src/lib/auth-secrets.ts is neither -- it reads process.env and nothing
 * else, with no database, crypto or Node-only dependency.)
 */
export const authConfig: NextAuthConfig = {
  pages: {
    signIn: "/login",
  },
  // Set explicitly because next-auth otherwise assigns AUTH_SECRET as a bare
  // string and closes the gate on @auth/core's own AUTH_SECRET_1..3 handling
  // -- so without this line the rotation slots reach the container and are
  // then ignored by the request gate, signIn and signOut, and any rotation
  // logs every signed-in user out. The full mechanism, the runtime evidence
  // and why the order is deliberately the reverse of upstream's are in
  // src/lib/auth-secrets.ts. An empty list leaves Auth.js to raise its own
  // MissingSecret, which is the correct behaviour for an unconfigured
  // deployment.
  secret: authSecrets(),
  // Enforce the Secure session cookie in production rather than inferring it.
  //
  // @auth/core decides the `__Secure-` prefix and the Secure attribute from
  // `config.useSecureCookies ?? url.protocol === "https:"`, where the URL comes
  // from AUTH_URL -- and AUTH_URL takes absolute precedence over the
  // X-Forwarded-Proto header Caddy sets, so an operator who writes
  // `AUTH_URL=http://...` gets a bare, non-Secure session cookie behind TLS with
  // nothing reporting it. Compose's ${AUTH_URL:?} guard cannot catch it either:
  // it checks presence, not scheme.
  //
  // Pinning this to true in production takes the decision away from a value an
  // operator can typo: the cookie stays Secure even when AUTH_URL says http://.
  //
  // The trade-off, measured rather than assumed: because the URL is no longer
  // consulted, a wrong AUTH_URL becomes INVISIBLE in the cookie. Production
  // build, both arms identical -- AUTH_URL=https://... and AUTH_URL=http://...
  // each return 302 from the credentials callback and set
  // __Secure-authjs.session-token with the Secure attribute. Login does not
  // fail, and the cookie name does not change. Anything that tells an operator
  // to detect a bad AUTH_URL by reading the cookie name is wrong; the only
  // detector is warnOnInsecureAuthUrl() in src/proxy.ts.
  //
  // Development is unaffected: the gate is NODE_ENV only, so http://localhost
  // keeps working.
  useSecureCookies: process.env.NODE_ENV === "production" ? true : undefined,
  providers: [],
  callbacks: {
    authorized({ auth }) {
      return !!auth?.user;
    },
  },
};
