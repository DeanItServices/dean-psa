import Link from "next/link";
import type { Role } from "@prisma/client";
import { can } from "@/lib/permissions";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

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
      className="flex h-full w-56 shrink-0 flex-col gap-1 border-r bg-sidebar p-4"
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
        {can(role, "admin:manage_users") && (
          <li>
            <span
              aria-disabled="true"
              title="Admin module is not available yet"
              className={cn(
                "flex cursor-not-allowed items-center justify-between rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/50",
              )}
            >
              Admin
              <span className="text-xs italic text-sidebar-foreground/40">
                (Coming soon)
              </span>
            </span>
          </li>
        )}
      </ul>
    </nav>
  );
}
