import type { Role } from "@prisma/client";
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  /**
   * NOTE: `Session` IS THE CLIENT-FACING SHAPE. NextAuth's own handlers serve
   * this object from GET /api/auth/session, a route that is exempt from the
   * middleware session gate and never consults getCurrentUser() -- so it
   * answers for tokens getCurrentUser() refuses. A field declared here is a
   * field published to any browser holding the cookie.
   *
   * `tokenVersion` was declared here and was being copied on by the session
   * callback; it is now deliberately absent from both. It is a
   * password-rotation counter, and exposing it also confirmed that a refused
   * token was still signature-valid. getCurrentUser() reads it from the raw
   * JWT (src/lib/session.ts's readSessionToken) instead, where it stays
   * server-side. Do not re-add it here to make some server-side read
   * convenient -- read the token.
   */
  interface Session {
    user: {
      id: string;
      role: Role;
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
  /**
   * The JWT is the SERVER-SIDE shape: it is the decrypted cookie payload, and
   * nothing outside this application ever sees it. This is where
   * `tokenVersion` lives, and where getCurrentUser() reads it from.
   */
  interface JWT {
    id: string;
    role: Role;
    /**
     * Token-generation counter captured when this JWT was minted.
     *
     * OPTIONAL for a runtime reason rather than a typing convenience: a JWT
     * minted by a build that predates this claim carries no `tokenVersion` at
     * all and stays signature-valid until maxAge expires. getCurrentUser()
     * must be able to SEE that absence and fail closed. Typing it as a
     * required `number` would make that mandatory check read as dead code and
     * invite a future edit to delete it.
     */
    tokenVersion?: number;
  }
}
