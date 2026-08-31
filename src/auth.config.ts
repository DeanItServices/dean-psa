import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe Auth.js base config.
 *
 * This file MUST remain runnable in the Next.js Edge runtime: no database
 * adapter, no password-hashing library, and no database imports of any kind.
 * A credentials-style provider that looks up a user row is not Edge-safe
 * either, so providers stays empty here.
 *
 * It is consumed by:
 *  - src/middleware.ts (Edge runtime) for a coarse "is there a session" check
 *  - src/auth.ts (Node runtime), which spreads this config and adds the
 *    database adapter, credentials provider, and database session strategy.
 *
 * Do not add providers, adapters, or Node-only imports here.
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
