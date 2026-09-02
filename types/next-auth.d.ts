import type { Role } from "@prisma/client";
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: Role;
    } & DefaultSession["user"];
  }

  // OPTIONAL on purpose: `authorize` is typed `=> Awaitable<User | null>`
  // (@auth/core/providers/credentials.d.ts) and src/auth.ts returns a literal
  // supplying only { id, email, name, role }. Under `strict: true`, declaring
  // these as required would fail that literal with TS2739.
  //
  // Deliberately NOT added to `Session` or `JWT`: the jwt/session callbacks in
  // src/auth.ts never set them, so a field declared there would be typed
  // `boolean` while being `undefined` at runtime forever. Consumers read these
  // from the Prisma row returned by getCurrentUser() instead.
  interface User {
    id: string;
    role: Role;
    isActive?: boolean;
    mustChangePassword?: boolean;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: Role;
  }
}
