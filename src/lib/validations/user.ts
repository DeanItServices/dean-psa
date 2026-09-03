import { z } from "zod";

/**
 * THE single source of truth for this application's password policy.
 *
 * Pinned at 12 characters with NO composition rules (no "one uppercase, one
 * digit, one symbol"), which is the modern guidance: composition rules push
 * users toward predictable substitutions while length is what actually costs
 * an attacker.
 *
 * Every consumer imports this constant rather than restating a number.
 * `scripts/create-admin.ts` (07-06) imports it directly; the /change-password
 * form (07-04) mirrors the literal 12 only because it was authored in the
 * same wave and could not import a file that did not yet exist -- 07-07
 * reconciles that. Three independent definitions of "minimum length" is how a
 * bootstrap admin ends up with a one-character password.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Role literals, kept as a string tuple rather than importing the Prisma
 * `Role` enum as a VALUE: these schemas are imported by client components,
 * and pulling @prisma/client into a client bundle is a build-weight and leak
 * hazard. The tuple mirrors `enum Role` in prisma/schema.prisma; the Server
 * Action that consumes it assigns the parsed value to a Prisma `Role` field,
 * so any drift between the two fails `tsc` at the call site.
 */
export const ROLE_VALUES = ["technician", "dispatcher", "sales", "finance", "admin"] as const;

/**
 * Email field for user accounts.
 *
 * ORDER IS LOAD-BEARING. `.trim()` and `.toLowerCase()` are Zod 4 string
 * transforms that run in declaration order BEFORE the piped `z.email()`
 * validator sees the value, so " Alice@Example.COM " is normalized to
 * "alice@example.com" and then validated. Validating first and normalizing
 * afterwards would let a stray leading space reject a legitimate address.
 *
 * Lowercasing here is a correctness requirement, not a nicety: `authorize()`
 * looks the account up with `email.toLowerCase()` (src/auth.ts:51), so an
 * account stored with any uppercase character is permanently unreachable --
 * login fails with the same anti-enumeration "Invalid email or password" a
 * wrong password produces, giving the admin who created it no signal at all.
 *
 * Zod 4 idiom: the top-level `z.email()` schema, not the deprecated
 * `z.string().email()` method used by the older Phase 2 validation files.
 */
const userEmail = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address"));

/**
 * New-account creation. Deliberately has NO password field: `createUser`
 * generates a cryptographically random temporary password server-side and
 * shows it to the admin exactly once. An admin never chooses, types, or
 * transmits another person's password.
 */
export const createUserSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  email: userEmail,
  role: z.enum(ROLE_VALUES),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

/**
 * Role change. Narrowed to exactly the one field `updateUserRole` persists,
 * following the `ticketUpdateSchema` precedent: validating fields the action
 * never writes creates drift between what is validated and what is stored.
 */
export const updateUserRoleSchema = z.object({
  role: z.enum(ROLE_VALUES),
});

export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>;
