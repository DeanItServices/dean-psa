import Link from "next/link";
import {
  Building2,
  FileText,
  LayoutDashboard,
  Receipt,
  Settings,
  Ticket,
} from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/components/ui/card";
import { can } from "@/lib/permissions";
import { requireActiveUser } from "@/lib/session";

type QuickLink = {
  href: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
};

/**
 * Same permission -> route mapping as AppSidebar, kept independent per-file
 * (not shared) since the dashboard's cards need per-item descriptions the
 * sidebar's nav items don't -- gating logic (can()) is still the single
 * source of truth, only the presentation differs.
 */
function getQuickLinks(role: Parameters<typeof can>[0]): QuickLink[] {
  const links: QuickLink[] = [];

  if (can(role, "crm:view")) {
    links.push({
      href: "/clients",
      label: "Clients",
      description: "Companies, contacts, contracts, and assets",
      icon: Building2,
    });
  }
  if (can(role, "ticket:view")) {
    links.push({
      href: "/tickets",
      label: "Tickets",
      description: "Kanban board, SLA tracking, and time entries",
      icon: Ticket,
    });
  }
  if (can(role, "invoice:view")) {
    links.push({
      href: "/invoices",
      label: "Invoices",
      description: "Generate and review invoices from logged time",
      icon: Receipt,
    });
  }
  if (can(role, "report:view_own")) {
    links.push({
      href: "/reports/utilization",
      label: "Reports",
      description: "Utilization, SLA compliance, and profitability",
      icon: FileText,
    });
  }
  if (can(role, "qbo:manage") || can(role, "admin:manage_users")) {
    links.push({
      href: "/admin/quickbooks",
      label: "Admin",
      description: "QuickBooks connection and system settings",
      icon: Settings,
    });
  }

  return links;
}

export default async function DashboardPage() {
  // requireActiveUser(), not getCurrentUser(): a shared layout does not
  // re-render on a soft navigation, so the inactive / mustChangePassword gate
  // has to run in the leaf too. See src/lib/session.ts. This page previously
  // had NO gate of its own at all -- it rendered "Welcome back, there" for a
  // null user and relied entirely on the layout.
  const user = await requireActiveUser();
  const displayName = user.name ?? user.email ?? "there";
  const quickLinks = getQuickLinks(user.role);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <LayoutDashboard className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Welcome back, {displayName}
          </h1>
          <p className="text-sm text-muted-foreground">
            Signed in as {user.role}
          </p>
        </div>
      </div>

      {quickLinks.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {quickLinks.map(({ href, label, description, icon: Icon }) => (
            <Link key={href} href={href}>
              <Card className="h-full transition-colors hover:border-primary/50 hover:bg-accent/50">
                <CardHeader className="flex flex-row items-center gap-3 space-y-0">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Icon className="h-5 w-5" />
                  </div>
                  <CardTitle className="text-base">{label}</CardTitle>
                </CardHeader>
                <CardContent>
                  <CardDescription>{description}</CardDescription>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              No modules are available for your role yet.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
