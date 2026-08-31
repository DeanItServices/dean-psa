import { db } from "@/lib/db";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { ContactForm } from "./contact-form";
import type { CrmTabProps } from "./tab-types";

/**
 * Contacts tab (real implementation, replacing Plan 02-02's placeholder
 * stub). Fetches the company's contacts and sites directly (it is an async
 * Server Component) rather than relying on a prop passed down from the
 * parent page, matching the established pattern in sites-tab.tsx --
 * CrmTabProps is intentionally limited to { companyId } only (see
 * 02-CONTEXT.md's Wave 3 parallel-safety contract -- no tab component may
 * require a second prop), so sites are re-fetched here for the
 * ContactForm's site dropdown rather than threaded through as a prop.
 */
export async function ContactsTab(props: CrmTabProps) {
  const { companyId } = props;

  const [contacts, sites] = await Promise.all([
    db.contact.findMany({
      where: { companyId },
      include: { site: true },
      orderBy: { createdAt: "asc" },
    }),
    db.site.findMany({
      where: { companyId },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Phone</TableHead>
            <TableHead>Title</TableHead>
            <TableHead>Site</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {contacts.length === 0 ? (
            <TableRow>
              <TableCell className="text-muted-foreground">
                No contacts yet.
              </TableCell>
            </TableRow>
          ) : (
            contacts.map((contact) => (
              <TableRow key={contact.id}>
                <TableCell>{contact.name}</TableCell>
                <TableCell>{contact.email || "-"}</TableCell>
                <TableCell>{contact.phone || "-"}</TableCell>
                <TableCell>{contact.title || "-"}</TableCell>
                <TableCell>
                  {contact.site
                    ? `${contact.site.addressLine1}, ${contact.site.city}`
                    : "-"}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Add a contact</h3>
        <ContactForm companyId={companyId} sites={sites} />
      </div>
    </div>
  );
}
