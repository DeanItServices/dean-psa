import type { NextAuthConfig } from "next-auth";

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
 */
export const authConfig: NextAuthConfig = {
  pages: {
    signIn: "/login",
  },
  providers: [],
  callbacks: {
    authorized({ auth }) {
      return !!auth?.user;
    },
  },
};
