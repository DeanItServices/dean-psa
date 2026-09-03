import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { requireActiveUser } from "@/lib/session";

// The one (dashboard) page that previously relied solely on the layout gate.
// The layout's own comment says that gate is insufficient on a soft navigation,
// so a user deactivated mid-session could soft-navigate here and be served the
// authenticated shell. No data leaks, but it breaks the invariant every other
// page in this group upholds -- and this is the page requireRole() redirects to.
export default async function UnauthorizedPage() {
  await requireActiveUser();

  return <UnauthorizedContent />;
}

function UnauthorizedContent() {
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-2xl">Access Denied</CardTitle>
        <CardDescription>
          You do not have permission to view this page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-muted-foreground">
          If you believe this is a mistake, contact an administrator.
        </p>
        <Button asChild>
          <Link href="/">Back to Dashboard</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
