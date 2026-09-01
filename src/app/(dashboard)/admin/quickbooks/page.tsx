import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { db } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { disconnectQbo, setCompanyQboCustomerId } from "@/lib/actions/qbo-connection";

const QBO_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "QuickBooks authorization was denied.",
  state_mismatch: "The connection request could not be verified (state mismatch). Please try again.",
  missing_params: "QuickBooks did not return the expected authorization details. Please try again.",
  token_exchange_failed: "Could not complete the connection to QuickBooks. Please try again.",
};

/**
 * Admin QuickBooks Online connection page (/admin/quickbooks). Gated by
 * can(role, "qbo:manage") -- see 04-CONTEXT.md's RBAC decisions. Shows the
 * current connection status (backed by the single QuickBooksConnection row
 * established by /api/qbo/connect + /api/qbo/callback), and lets an admin
 * manually set each Company's qboCustomerId. No QBO Customer search/create
 * or auto-matching is performed here -- qboCustomerId is a plain admin-typed
 * text field; Plan 04-06's invoice push logic is expected to read it.
 */
export default async function QuickBooksAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ qbo_connected?: string; qbo_error?: string }>;
}) {
  const { qbo_connected, qbo_error } = await searchParams;

  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  if (!can(user.role, "qbo:manage")) {
    redirect("/unauthorized");
  }

  const [connection, companies] = await Promise.all([
    db.quickBooksConnection.findFirst(),
    db.company.findMany({
      select: { id: true, name: true, qboCustomerId: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const isConnected = Boolean(connection);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">QuickBooks Online</h1>

      {qbo_connected && (
        <p className="rounded-md border border-green-600/30 bg-green-600/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
          Successfully connected to QuickBooks.
        </p>
      )}
      {qbo_error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {QBO_ERROR_MESSAGES[qbo_error] ?? "Something went wrong connecting to QuickBooks."}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Connection status
            {isConnected ? (
              <Badge>Connected</Badge>
            ) : (
              <Badge variant="outline">Not connected</Badge>
            )}
          </CardTitle>
          <CardDescription>
            {isConnected
              ? "This app is authorized to access your QuickBooks Online company."
              : "Connect this app to a QuickBooks Online company to enable invoice push."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isConnected && connection && (
            <p className="text-sm text-muted-foreground">
              Realm ID: <span className="font-mono">{connection.realmId}</span>
            </p>
          )}
        </CardContent>
        <CardFooter>
          {isConnected ? (
            <form
              action={async () => {
                "use server";
                await disconnectQbo();
              }}
            >
              <Button type="submit" variant="destructive">
                Disconnect
              </Button>
            </form>
          ) : (
            <Button asChild>
              <a href="/api/qbo/connect">Connect to QuickBooks</a>
            </Button>
          )}
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Company QuickBooks Customer linking</CardTitle>
          <CardDescription>
            Manually enter each company&apos;s QuickBooks Customer ID. This is not
            auto-matched -- look up the Customer ID in QuickBooks Online and paste
            it here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Company</TableHead>
                <TableHead>QuickBooks Customer ID</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {companies.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-muted-foreground">
                    No companies yet.
                  </TableCell>
                </TableRow>
              ) : (
                companies.map((company) => {
                  const updateAction = async (formData: FormData) => {
                    "use server";
                    const value = formData.get("qboCustomerId");
                    await setCompanyQboCustomerId(
                      company.id,
                      typeof value === "string" ? value : null,
                    );
                  };

                  return (
                    <TableRow key={company.id}>
                      <TableCell className="font-medium">{company.name}</TableCell>
                      <TableCell colSpan={2}>
                        <form
                          action={updateAction}
                          className="flex items-center gap-2"
                        >
                          <Label htmlFor={`qbo-${company.id}`} className="sr-only">
                            QuickBooks Customer ID for {company.name}
                          </Label>
                          <Input
                            id={`qbo-${company.id}`}
                            name="qboCustomerId"
                            defaultValue={company.qboCustomerId ?? ""}
                            placeholder="e.g. 42"
                            className="max-w-xs"
                          />
                          <Button type="submit" variant="secondary" size="sm">
                            Save
                          </Button>
                        </form>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
