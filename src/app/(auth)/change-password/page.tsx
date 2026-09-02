import { redirect } from "next/navigation";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { getCurrentUser } from "@/lib/session";
import { ChangePasswordForm } from "./change-password-form";

/**
 * Password change surface for a user holding an admin-issued temporary
 * credential.
 *
 * Route-group placement is load-bearing. This lives in (auth), whose layout
 * (src/app/(auth)/layout.tsx) is a plain centered-card wrapper performing no
 * session check. That is what keeps the page reachable while authenticated
 * without sitting behind the (dashboard) gate that redirects here -- the gate
 * and its target must not be the same segment, or the redirect loops forever.
 *
 * The session is resolved with getCurrentUser(), not the role-gate helper
 * alongside it, for the same reason the action does: the gate redirects on
 * exactly the state every visitor here is in.
 */
export default async function ChangePasswordPage() {
  const user = await getCurrentUser();

  if (!user) {
    // No session: the action would refuse anyway, so don't render a form that
    // cannot succeed.
    redirect("/login");
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-center text-2xl">
          Choose a new password
        </CardTitle>
        <CardDescription className="text-center">
          Your account is using a temporary password. Set a new one to continue.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChangePasswordForm />
      </CardContent>
    </Card>
  );
}
