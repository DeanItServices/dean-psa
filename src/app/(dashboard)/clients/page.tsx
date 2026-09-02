import Link from "next/link";
import { redirect } from "next/navigation";
import { requireActiveUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { db } from "@/lib/db";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

/**
 * Company list page (/clients). View-gated by can(role, "crm:view") --
 * every role has this permission, but the check is still explicit per
 * 02-CONTEXT.md's anti-hardcoding principle (never assume all roles pass).
 * "Add Company" is additionally gated by can(role, "crm:manage") so
 * technician/dispatcher never see a write affordance they can't use.
 */
export default async function ClientsPage() {
  // requireActiveUser(), not getCurrentUser(): a shared layout does not
  // re-render on a soft navigation, so the inactive / mustChangePassword gate
  // has to run in the leaf too. See src/lib/session.ts. It also subsumes the
  // !user -> /login redirect this page used to open-code.
  const user = await requireActiveUser();

  if (!can(user.role, "crm:view")) {
    redirect("/unauthorized");
  }

  const companies = await db.company.findMany({
    orderBy: { name: "asc" },
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Clients</h1>
        {can(user.role, "crm:manage") && (
          <Button asChild>
            <Link href="/clients/new">Add Company</Link>
          </Button>
        )}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {companies.length === 0 ? (
            <TableRow>
              <TableCell className="text-muted-foreground">
                No companies yet.
              </TableCell>
            </TableRow>
          ) : (
            companies.map((company) => (
              <TableRow key={company.id}>
                <TableCell>
                  <Link
                    href={`/clients/${company.id}`}
                    className="font-medium hover:underline"
                  >
                    {company.name}
                  </Link>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
