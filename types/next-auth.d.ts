import type { Role } from "@prisma/client";
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: Role;
      /**
       * Token-generation counter captured when this session's JWT was minted.
       *
       * This one IS augmented, unlike isActive/mustChangePassword below: the
       * session callback in src/auth.ts genuinely sets it, so the earlier
       * "no callback ever writes this" rationale does not apply here.
       *
       * OPTIONAL for a runtime reason rather than a typing convenience: a JWT
       * minted by a build that predates this claim carries no `tokenVersion`
       * at all and stays signature-valid until maxAge expires. getCurrentUser()
       * must be able to SEE that absence and fail closed. Typing it as a
       * required `number` would make that mandatory check read as dead code
       * and invite a future edit to delete it.
       */
      tokenVersion?: number;
    } & DefaultSession["user"];
  }

  // OPTIONAL on purpose: `authorize` is typed `=> Awaitable<User | null>`
  // (@auth/core/providers/credentials.d.ts) and src/auth.ts returns a literal
  // supplying only { id, email, name, role, tokenVersion }. Under
  // `strict: true`, declaring these as required would fail that literal with
  // TS2739.
  //
  // isActive and mustChangePassword remain deliberately absent from `Session`
  // and `JWT`: no callback sets those two, so a field declared there would be
  // typed `boolean` while being `undefined` at runtime forever. Consumers read
  // them from the Prisma row returned by getCurrentUser() instead.
  interface User {
    id: string;
    role: Role;
    isActive?: boolean;
    mustChangePassword?: boolean;
    tokenVersion?: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: Role;
    /** See the Session augmentation above for why this is optional. */
    tokenVersion?: number;
  }
}
