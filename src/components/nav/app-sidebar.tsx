import Link from "next/link";
import type { Role } from "@prisma/client";
import { can } from "@/lib/permissions";
import { Separator } from "@/components/ui/separator";

/**
 * Role-aware primary navigation. Every conditionally-rendered item is gated
 * through can(role, permission) -- never a hardcoded role-name comparison --
 * so later phases (ticketing, billing, CRM) can extend this list by adding
 * new permission-gated items without touching the gating pattern itself.
 */
export function AppSidebar({ role }: { role: Role }) {
  return (
    <nav
      aria-label="Primary"
      className="flex w-56 shrink-0 flex-col gap-1 border-r bg-sidebar p-4"
    >
      <div className="px-2 pb-2 text-sm font-semibold text-sidebar-foreground">
        MSP PSA
      </div>
      <Separator className="mb-2" />
      <ul className="flex flex-col gap-1">
        {can(role, "dashboard:view") && (
          <li>
            <Link
              href="/"
              className="block rounded-md px-2 py-1.5 text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              Dashboard
            </Link>
          </li>
        )}
        {can(role, "crm:view") && (
          <li>
            <Link
              href="/clients"
              className="block rounded-md px-2 py-1.5 text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              Clients
            </Link>
          </li>
        )}
        {can(role, "ticket:view") && (
          <li>
            <Link
              href="/tickets"
              className="block rounded-md px-2 py-1.5 text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              Tickets
            </Link>
          </li>
        )}
        {can(role, "invoice:view") && (
          <li>
            <Link
              href="/invoices"
              className="block rounded-md px-2 py-1.5 text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              Invoices
            </Link>
          </li>
        )}
        {can(role, "report:view_own") && (
          <li>
            <Link
              href="/reports/utilization"
              className="block rounded-md px-2 py-1.5 text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              Reports
            </Link>
          </li>
        )}
        {/*
          Admin SECTION, not a single Admin link. Each destination is gated on
          the permission its own route actually checks --
          /admin/quickbooks/page.tsx gates on "qbo:manage", /admin/users gates
          on "admin:manage_users" via requireRole(ADMIN_MANAGE_ROLES). Both
          resolve to admin today, so collapsing them onto one guard would look
          identical and be wrong the moment either permission is widened: the
          nav would offer a link to a page that refuses the visitor.

          The outer guard stays on "admin:manage_users" so the heading itself
          only appears for someone who has an admin surface at all. The former
          "(Coming soon)" else-branch was deleted rather than preserved: its
          condition (can qbo:manage || can admin:manage_users) could never be
          false inside a block already gated on the latter, so it was
          unreachable code describing a state that no longer exists.
        */}
        {can(role, "admin:manage_users") && (
          <li>
            <h2
              id="sidebar-admin-heading"
              className="px-2 pt-3 pb-1 text-xs font-semibold tracking-wide text-sidebar-foreground/60 uppercase"
            >
              Admin
            </h2>
            <ul aria-labelledby="sidebar-admin-heading" className="flex flex-col gap-1">
              {can(role, "qbo:manage") && (
                <li>
                  <Link
                    href="/admin/quickbooks"
                    className="block rounded-md px-2 py-1.5 text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  >
                    QuickBooks
                  </Link>
                </li>
              )}
              {can(role, "admin:manage_users") && (
                <li>
                  <Link
                    href="/admin/users"
                    className="block rounded-md px-2 py-1.5 text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  >
                    Users
                  </Link>
                </li>
              )}
            </ul>
          </li>
        )}
      </ul>
    </nav>
  );
}
