import { db } from "@/lib/db";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { ContractForm } from "./contract-form";
import type { CrmTabProps } from "./tab-types";

const BILLING_TYPE_LABELS: Record<string, string> = {
  block_hour: "Block Hours",
  flat_fee: "Flat Fee",
  hourly_breakfix: "Hourly Break-Fix",
};

function formatDate(date: Date | null): string {
  if (!date) return "--";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(date);
}

function formatAmount(contract: {
  billingType: string;
  blockHours: number | null;
  flatFeeAmount: unknown;
  hourlyRate: unknown;
}): string {
  switch (contract.billingType) {
    case "block_hour":
      return contract.blockHours != null ? `${contract.blockHours} hrs/mo` : "--";
    case "flat_fee":
      return contract.flatFeeAmount != null ? `$${contract.flatFeeAmount}` : "--";
    case "hourly_breakfix":
      return contract.hourlyRate != null ? `$${contract.hourlyRate}/hr` : "--";
    default:
      return "--";
  }
}

/**
 * Contracts tab (real implementation, replacing Plan 02-02's placeholder
 * stub). Fetches the company's contracts directly (async Server Component,
 * matching SitesTab's pattern) rather than relying on a prop passed down
 * from the parent page -- CrmTabProps is intentionally limited to
 * { companyId } only (see 02-CONTEXT.md's Wave 3 parallel-safety contract).
 *
 * Lists billing type, the one amount/rate field relevant to that type, SLA
 * targets, and start/end dates. Renders ContractForm below the list for
 * creating new contracts.
 */
export async function ContractsTab(props: CrmTabProps) {
  const { companyId } = props;

  const contracts = await db.contract.findMany({
    where: { companyId },
    orderBy: { startDate: "desc" },
  });

  return (
    <div className="flex flex-col gap-6">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Billing Type</TableHead>
            <TableHead>Amount / Rate</TableHead>
            <TableHead>SLA Response</TableHead>
            <TableHead>SLA Resolution</TableHead>
            <TableHead>Start Date</TableHead>
            <TableHead>End Date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {contracts.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground">
                No contracts yet.
              </TableCell>
            </TableRow>
          ) : (
            contracts.map((contract) => (
              <TableRow key={contract.id}>
                <TableCell>
                  {BILLING_TYPE_LABELS[contract.billingType] ?? contract.billingType}
                </TableCell>
                <TableCell>{formatAmount(contract)}</TableCell>
                <TableCell>
                  {contract.slaResponseMinutes != null
                    ? `${contract.slaResponseMinutes} min`
                    : "--"}
                </TableCell>
                <TableCell>
                  {contract.slaResolutionMinutes != null
                    ? `${contract.slaResolutionMinutes} min`
                    : "--"}
                </TableCell>
                <TableCell>{formatDate(contract.startDate)}</TableCell>
                <TableCell>{formatDate(contract.endDate)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Add a contract</h3>
        <ContractForm companyId={companyId} />
      </div>
    </div>
  );
}
