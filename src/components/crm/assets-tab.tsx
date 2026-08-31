import { db } from "@/lib/db";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { AssetForm } from "./asset-form";
import type { CrmTabProps } from "./tab-types";

/**
 * Assets tab (real implementation, replacing the Plan 02-02 placeholder).
 * Fetches the company's assets and sites directly (it is an async Server
 * Component) rather than relying on a prop passed down from the parent
 * page, since CrmTabProps is intentionally limited to { companyId } only
 * (see 02-CONTEXT.md's Wave 3 parallel-safety contract -- no tab component
 * may require a second prop). Sites are fetched here too, only to populate
 * AssetForm's optional site select.
 */
export async function AssetsTab(props: CrmTabProps) {
  const { companyId } = props;

  const [assets, sites] = await Promise.all([
    db.asset.findMany({
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
            <TableHead>Type</TableHead>
            <TableHead>Serial Number</TableHead>
            <TableHead>Site</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {assets.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground">
                No assets yet.
              </TableCell>
            </TableRow>
          ) : (
            assets.map((asset) => (
              <TableRow key={asset.id}>
                <TableCell>{asset.name}</TableCell>
                <TableCell>{asset.assetType}</TableCell>
                <TableCell>{asset.serialNumber ?? "—"}</TableCell>
                <TableCell>
                  {asset.site ? asset.site.addressLine1 : "—"}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Add an asset</h3>
        <AssetForm
          companyId={companyId}
          sites={sites.map((site) => ({
            id: site.id,
            addressLine1: site.addressLine1,
          }))}
        />
      </div>
    </div>
  );
}
