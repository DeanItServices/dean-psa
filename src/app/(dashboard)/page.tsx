import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/components/ui/card";
import { getCurrentUser } from "@/lib/session";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  const displayName = user?.name ?? user?.email ?? "there";

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-2xl">Welcome, {displayName}</CardTitle>
        <CardDescription>
          Signed in as {user?.role ?? "unknown role"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          This is the MSP PSA dashboard. Feature modules (tickets, clients,
          billing, reporting) will appear here in later phases.
        </p>
      </CardContent>
    </Card>
  );
}
