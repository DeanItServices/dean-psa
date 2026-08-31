import type { Role } from "@prisma/client";

/**
 * Baseline permission set for Phase 1. Later phases extend this union and
 * the ROLE_PERMISSIONS matrix below -- do not replace this pattern with a
 * database-backed Permission/RolePermission schema (see 01-CONTEXT.md).
 */
export type Permission =
  | "dashboard:view"
  | "admin:manage_users"
  | "crm:view"
  | "crm:manage";

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  technician: ["dashboard:view", "crm:view"],
  dispatcher: ["dashboard:view", "crm:view"],
  sales: ["dashboard:view", "crm:view", "crm:manage"],
  finance: ["dashboard:view", "crm:view", "crm:manage"],
  admin: ["dashboard:view", "admin:manage_users", "crm:view", "crm:manage"],
};

/**
 * Single source of truth for which roles may create/edit/delete CRM records
 * (Company, Site, Contact, Contract, Asset). Every CRM Server Action imports
 * this constant for its requireRole() call instead of hardcoding its own
 * literal role array -- see 02-CONTEXT.md's RBAC decisions.
 */
export const CRM_MANAGE_ROLES: Role[] = ["sales", "finance", "admin"];

/**
 * Centralized authorization check. Fail-secure: any role not present in the
 * matrix (should not happen given the Role enum, but defends against a
 * future enum/matrix drift) denies the permission rather than throwing or
 * defaulting to allow.
 */
export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
