import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { AppSidebar } from "@/components/nav/app-sidebar";
import { UserMenu } from "@/components/nav/user-menu";

/**
 * Authenticated application shell. Wraps every route in the (dashboard)
 * route group with a role-aware sidebar and a user menu.
 *
 * getCurrentUser() here is a defense-in-depth check alongside middleware
 * (Plan 01-03): middleware only verifies a session cookie is present at the
 * Edge, this Server Component performs the authoritative Node-side check
 * and redirects to /login if there is no session.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="flex min-h-screen">
      <AppSidebar role={user.role} />
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-end border-b bg-background px-6 py-3">
          <UserMenu name={user.name ?? null} email={user.email ?? ""} />
        </header>
        <main className="flex flex-1 flex-col bg-background p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
