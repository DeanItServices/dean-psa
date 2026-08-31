import { db } from "@/lib/db";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { SiteForm } from "./site-form";
import type { CrmTabProps } from "./tab-types";

/**
 * Sites tab (real implementation, replacing nothing -- this plan owns this
 * file). Fetches the company's sites directly (it is an async Server
 * Component) rather than relying on a prop passed down from the parent
 * page, since CrmTabProps is intentionally limited to { companyId } only
 * (see 02-CONTEXT.md's Wave 3 parallel-safety contract -- no tab component
 * may require a second prop).
 */
export async function SitesTab(props: CrmTabProps) {
  const { companyId } = props;

  const sites = await db.site.findMany({
    where: { companyId },
    orderBy: { createdAt: "asc" },
  });

  return (
    <div className="flex flex-col gap-6">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Address</TableHead>
            <TableHead>City</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Postal Code</TableHead>
            <TableHead>Country</TableHead>
            <TableHead>Primary</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sites.length === 0 ? (
            <TableRow>
              <TableCell className="text-muted-foreground">
                No sites yet.
              </TableCell>
            </TableRow>
          ) : (
            sites.map((site) => (
              <TableRow key={site.id}>
                <TableCell>
                  {site.addressLine1}
                  {site.addressLine2 ? `, ${site.addressLine2}` : ""}
                </TableCell>
                <TableCell>{site.city}</TableCell>
                <TableCell>{site.state}</TableCell>
                <TableCell>{site.postalCode}</TableCell>
                <TableCell>{site.country}</TableCell>
                <TableCell>{site.isPrimary ? "Yes" : "No"}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Add a site</h3>
        <SiteForm companyId={companyId} />
      </div>
    </div>
  );
}
