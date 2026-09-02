import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { db } from "@/lib/db";
import { authConfig } from "./auth.config";

// NOTE: Auth.js v5 hard-rejects `session.strategy: "database"` combined with
// a Credentials-only provider list (see @auth/core's assert.js:
// "Signing in with credentials only supported if JWT strategy is enabled").
// The original design called for database sessions for admin-side session
// revocation, but that combination is unsupported by the library for a
// Credentials-only setup. Using JWT session strategy instead; the Prisma
// adapter is not used here since JWT sessions are self-contained and do not
// need adapter-backed session storage.
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  session: {
    strategy: "jwt",
    // Shortened from Auth.js's 30-day default. KEPT AT 8 HOURS, revisited
    // deliberately: revocation is no longer impossible. getCurrentUser()
    // (src/lib/session.ts) now re-reads the user row on every request, so an
    // offboarded technician is refused on their next request rather than at
    // the end of maxAge, and authorize() below refuses them a fresh token.
    // maxAge is therefore no longer the revocation mechanism -- but it is
    // still the bound on the one case the database check cannot see: a JWT
    // stolen from a user nobody has deactivated, which stays replayable
    // until it expires. 8 hours keeps that window to roughly one business
    // day while avoiding constant re-logins for an internal tool.
    maxAge: 60 * 60 * 8,
  },
  providers: [
    Credentials({
      credentials: {
        email: {},
        password: {},
      },
      authorize: async (credentials) => {
        // Validate input shape at this system boundary. Never trust the
        // caller -- reject anything that isn't a well-formed string pair
        // before touching the database.
        const email = credentials?.email;
        const password = credentials?.password;

        if (
          typeof email !== "string" ||
          typeof password !== "string" ||
          email.length === 0 ||
          password.length === 0
        ) {
          return null;
        }

        const user = await db.user.findUnique({
          where: { email: email.toLowerCase() },
        });

        // SECURITY: Do not distinguish "user not found" from "user has no
        // password set" (e.g. an OAuth-only account) from "deactivated" from
        // "wrong password". Every failure path below returns null
        // identically -- same value, same absence of a message, same absence
        // of a log line -- so neither the caller nor any error surfaced to
        // the client can be used to enumerate valid account emails or to
        // tell a deactivated account from one that never existed.
        //
        // isActive is checked HERE rather than after the password compare so
        // that a deactivated account is indistinguishable from a nonexistent
        // one by response timing too (both skip bcrypt). Without this check
        // deactivation would be trivially bypassable: the offboarded user
        // simply logs in again and mints a fresh 8-hour JWT.
        if (!user || !user.hashedPassword || !user.isActive) {
          return null;
        }

        const isValidPassword = await compare(password, user.hashedPassword);

        if (!isValidPassword) {
          return null;
        }

        // tokenVersion is captured HERE, at mint time, and carried on the JWT
        // by the callback below. getCurrentUser() compares it against the
        // column on every request, so any later increment (password reset,
        // password change) invalidates this token and every other one issued
        // before it.
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          tokenVersion: user.tokenVersion,
        };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    jwt: async ({ token, user }) => {
      // `user` is only defined on the initial sign-in call; persist the
      // fields we need onto the token for every subsequent request.
      //
      // tokenVersion is stamped ONCE, at sign-in, and never refreshed from the
      // database afterwards. That is the whole mechanism: a token frozen at
      // the generation it was minted in, compared against the live column by
      // getCurrentUser(). Re-reading it here on every call would make the
      // token silently self-heal after a revoking write and defeat the check.
      if (user) {
        token.id = user.id as string;
        token.role = user.role as typeof token.role;
        token.tokenVersion = user.tokenVersion;
      }
      return token;
    },
    session: async ({ session, token }) => {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as typeof session.user.role;
        session.user.tokenVersion = token.tokenVersion;
      }
      return session;
    },
  },
});
