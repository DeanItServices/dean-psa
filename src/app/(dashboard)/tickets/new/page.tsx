import { redirect } from "next/navigation";
import { requireActiveUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { db } from "@/lib/db";
import { TicketForm } from "@/components/tickets/ticket-form";

/**
 * Create-ticket page (/tickets/new). Gated with can(user.role,
 * "ticket:manage") -- stricter than the board's ticket:view gate, since
 * this is a create-action entry point (matches the ticket:manage role set:
 * technician, dispatcher, admin). A user with only ticket:view (sales,
 * finance) navigating here directly is redirected to /unauthorized
 * server-side, not merely hidden in the nav UI.
 */
export default async function NewTicketPage() {
  // requireActiveUser(), not getCurrentUser(): a shared layout does not
  // re-render on a soft navigation, so the inactive / mustChangePassword gate
  // has to run in the leaf too. See src/lib/session.ts. It also subsumes the
  // !user -> /login redirect this page used to open-code.
  const user = await requireActiveUser();

  if (!can(user.role, "ticket:manage")) {
    redirect("/unauthorized");
  }

  const [companies, contacts, assets, users] = await Promise.all([
    db.company.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.contact.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, companyId: true },
    }),
    db.asset.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, companyId: true },
    }),
    db.user.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">New Ticket</h1>
      <TicketForm companies={companies} contacts={contacts} assets={assets} users={users} />
    </div>
  );
}
