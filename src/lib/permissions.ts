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
  | "crm:manage"
  | "ticket:view"
  | "ticket:manage"
  | "ticket:assign"
  | "timeentry:manage"
  | "invoice:view"
  | "invoice:manage"
  | "invoice:push_qbo"
  | "qbo:manage"
  | "report:view_own"
  | "report:view_all";

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  technician: [
    "dashboard:view",
    "crm:view",
    "ticket:view",
    "ticket:manage",
    "timeentry:manage",
    "report:view_own",
  ],
  dispatcher: [
    "dashboard:view",
    "crm:view",
    "ticket:view",
    "ticket:manage",
    "ticket:assign",
    "timeentry:manage",
    "report:view_own",
    "report:view_all",
  ],
  sales: ["dashboard:view", "crm:view", "crm:manage", "ticket:view", "report:view_own"],
  finance: [
    "dashboard:view",
    "crm:view",
    "crm:manage",
    "ticket:view",
    "invoice:view",
    "invoice:manage",
    "invoice:push_qbo",
    "report:view_own",
    "report:view_all",
  ],
  admin: [
    "dashboard:view",
    "admin:manage_users",
    "crm:view",
    "crm:manage",
    "ticket:view",
    "ticket:manage",
    "ticket:assign",
    "timeentry:manage",
    "invoice:view",
    "invoice:manage",
    "invoice:push_qbo",
    "qbo:manage",
    "report:view_own",
    "report:view_all",
  ],
};

/**
 * Single source of truth for which roles may create, re-role, reset the
 * password of, deactivate or reactivate a User account (i.e. hold
 * "admin:manage_users"). Every user-lifecycle Server Action imports this
 * constant for its requireRole() call instead of hardcoding its own literal
 * role array -- see 07-CONTEXT.md's RBAC decisions. Peer admins are
 * deliberately unrestricted: any admin may act on any OTHER admin, and the
 * actions themselves enforce the self-target and last-active-admin guard
 * rails that this constant cannot express.
 */
export const ADMIN_MANAGE_ROLES: Role[] = ["admin"];

/**
 * Single source of truth for which roles may create/edit/delete CRM records
 * (Company, Site, Contact, Contract, Asset). Every CRM Server Action imports
 * this constant for its requireRole() call instead of hardcoding its own
 * literal role array -- see 02-CONTEXT.md's RBAC decisions.
 */
export const CRM_MANAGE_ROLES: Role[] = ["sales", "finance", "admin"];

/**
 * Single source of truth for which roles may create/edit/delete/status-change
 * Ticket records. Every ticket Server Action imports this constant for its
 * requireRole() call instead of hardcoding its own literal role array -- see
 * 03-CONTEXT.md's RBAC decisions.
 */
export const TICKET_MANAGE_ROLES: Role[] = ["technician", "dispatcher", "admin"];

/**
 * Single source of truth for which roles may change a Ticket's assignedToId
 * (triage/dispatch). Every ticket assignment Server Action imports this
 * constant for its requireRole() call instead of hardcoding its own literal
 * role array -- see 03-CONTEXT.md's RBAC decisions.
 */
export const TICKET_ASSIGN_ROLES: Role[] = ["dispatcher", "admin"];

/**
 * Single source of truth for which roles may start/stop timers and
 * create/edit/delete TimeEntry records. Every time-entry Server Action
 * imports this constant for its requireRole() call instead of hardcoding
 * its own literal role array -- see 04-CONTEXT.md's RBAC decisions.
 */
export const TIME_ENTRY_MANAGE_ROLES: Role[] = ["technician", "dispatcher", "admin"];

/**
 * Single source of truth for which roles may view, generate, finalize, and
 * push Invoice records to QuickBooks. Every invoice Server Action imports
 * this constant for its requireRole() call instead of hardcoding its own
 * literal role array -- see 04-CONTEXT.md's RBAC decisions.
 */
export const INVOICE_MANAGE_ROLES: Role[] = ["finance", "admin"];

/**
 * Single source of truth for which roles may connect/disconnect the
 * QuickBooks OAuth connection. Every QBO-connection Server Action imports
 * this constant for its requireRole() call instead of hardcoding its own
 * literal role array -- see 04-CONTEXT.md's RBAC decisions.
 */
export const QBO_MANAGE_ROLES: Role[] = ["admin"];

/**
 * Single source of truth for which roles may view cross-technician
 * utilization, the SLA compliance report, and the client profitability
 * report (i.e. hold "report:view_all", not just the self-scoped
 * "report:view_own" every role has). Every reporting page/query helper
 * imports this constant instead of hardcoding its own literal role array --
 * see 05-CONTEXT.md's RBAC decision (dispatcher is included alongside
 * finance/admin for workload-triage and SLA-visibility reasons; technician
 * and sales are excluded).
 */
export const REPORT_VIEW_ALL_ROLES: Role[] = ["dispatcher", "finance", "admin"];

/**
 * Centralized authorization check. Fail-secure: any role not present in the
 * matrix (should not happen given the Role enum, but defends against a
 * future enum/matrix drift) denies the permission rather than throwing or
 * defaulting to allow.
 */
export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
