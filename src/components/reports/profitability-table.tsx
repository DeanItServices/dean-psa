import type { ProfitabilityRow } from "@/lib/reporting";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const COLUMN_COUNT = 3;

/** Formats a plain number as USD currency, e.g. "$1,234.56". */
function formatCurrency(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Formats a plain hours number as e.g. "42.5h". */
function formatHours(value: number): string {
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}h`;
}

/**
 * Renders client profitability rows: Client, Billed Revenue, Hours Invested.
 * Deliberately does NOT compute or display a dollar "cost" or "profit"
 * figure -- see 05-CONTEXT.md's "Client profitability 'cost' decision" (a
 * hourlyRate-derived cost would be misleading for flat-fee/block-hour
 * contracts, which don't have a per-hour rate set). This table only ever
 * shows billed revenue (from Invoice totals) and hours invested (from
 * TimeEntry durations), side by side for comparison -- never blended into a
 * single derived dollar figure.
 */
export function ProfitabilityTable({ rows }: { rows: ProfitabilityRow[] }) {
  return (
    <div className="flex flex-col gap-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Client</TableHead>
            <TableHead className="text-right">Billed Revenue</TableHead>
            <TableHead className="text-right">Hours Invested</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={COLUMN_COUNT} className="text-center text-muted-foreground">
                No profitability data for this date range.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.companyId}>
                <TableCell className="font-medium">{row.companyName}</TableCell>
                <TableCell className="text-right">{formatCurrency(row.billedRevenue)}</TableCell>
                <TableCell className="text-right">{formatHours(row.hoursInvested)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">
        This report compares billed revenue against hours invested per client. It is not a
        computed dollar cost or profit margin -- the codebase has no technician pay-rate/cost
        model, so hours invested is shown strictly as a raw hours figure and is never converted
        to or blended with a dollar amount.
      </p>
    </div>
  );
}
