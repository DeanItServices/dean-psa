import type { Role } from "@prisma/client";

/**
 * Baseline permission set for Phase 1. Later phases extend this union and
 * the ROLE_PERMISSIONS matrix below -- do not replace this pattern with a
 * database-backed Permission/RolePermission schema (see 01-CONTEXT.md).
 */
export type Permission = "dashboard:view" | "admin:manage_users";

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  technician: ["dashboard:view"],
  dispatcher: ["dashboard:view"],
  sales: ["dashboard:view"],
  finance: ["dashboard:view"],
  admin: ["dashboard:view", "admin:manage_users"],
};

/**
 * Centralized authorization check. Fail-secure: any role not present in the
 * matrix (should not happen given the Role enum, but defends against a
 * future enum/matrix drift) denies the permission rather than throwing or
 * defaulting to allow.
 */
export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
