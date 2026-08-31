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
    // Shortened from Auth.js's 30-day default. Because JWT sessions are
    // self-contained (no adapter-backed session store), there is no
    // server-side mechanism to revoke a token early -- a leaked JWT, or one
    // issued to a technician who is later offboarded, otherwise stays valid
    // for the full maxAge. 8 hours bounds that exposure window to roughly
    // one business day while still avoiding constant re-logins for an
    // internal tool.
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
        // password set" (e.g. an OAuth-only account) from "wrong password".
        // Every failure path below returns null identically so the caller
        // (and any error message surfaced to the client) cannot be used to
        // enumerate valid account emails.
        if (!user || !user.hashedPassword) {
          return null;
        }

        const isValidPassword = await compare(password, user.hashedPassword);

        if (!isValidPassword) {
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    jwt: async ({ token, user }) => {
      // `user` is only defined on the initial sign-in call; persist the
      // fields we need onto the token for every subsequent request.
      if (user) {
        token.id = user.id as string;
        token.role = user.role as typeof token.role;
      }
      return token;
    },
    session: async ({ session, token }) => {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as typeof session.user.role;
      }
      return session;
    },
  },
});
