import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { compare } from "bcryptjs";
import { db } from "@/lib/db";
import { authConfig } from "./auth.config";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(db),
  session: {
    strategy: "database",
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
    session: async ({ session, user }) => {
      if (session.user) {
        session.user.id = user.id;
        session.user.role = user.role as typeof session.user.role;
      }
      return session;
    },
  },
});
