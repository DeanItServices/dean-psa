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
 * and redirects to /login if there is no session. It also resolves the user
 * from the database, so a deactivated or deleted account lands here as null.
 *
 * The /change-password redirect below is UX, NOT the security boundary --
 * requireRole() in @/lib/session enforces the same flag for every Server
 * Action, which is what actually stops a temp-password holder from acting.
 * It cannot loop: /change-password lives in the (auth) route group, whose
 * layout (src/app/(auth)/layout.tsx) is a plain centered-card wrapper with
 * no session check, so it never re-enters this layout.
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

  if (user.mustChangePassword) {
    redirect("/change-password");
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
