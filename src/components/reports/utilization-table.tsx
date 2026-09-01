import type { UtilizationRow } from "@/lib/reporting";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const COLUMN_COUNT = 4;

/** Formats a minute count as "12h 30m" (or "0h 0m" for zero). */
function formatMinutesAsHours(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = Math.round(minutes % 60);
  return `${hours}h ${remainingMinutes}m`;
}

/**
 * Renders technician utilization rows: Technician, Minutes Logged (as
 * hours), Capacity, Utilization %. Includes a visible disclaimer that
 * "capacity" is a fixed 8hr/weekday estimate, not each technician's real
 * schedule (see 05-CONTEXT.md's "Utilization capacity decision") -- this
 * must be visible in the rendered UI, not only a code comment.
 */
export function UtilizationTable({ rows }: { rows: UtilizationRow[] }) {
  return (
    <div className="flex flex-col gap-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Technician</TableHead>
            <TableHead>Minutes Logged</TableHead>
            <TableHead>Capacity</TableHead>
            <TableHead className="text-right">Utilization %</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={COLUMN_COUNT} className="text-center text-muted-foreground">
                No utilization data for this date range.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.userId}>
                <TableCell className="font-medium">{row.userName}</TableCell>
                <TableCell>{formatMinutesAsHours(row.minutesLogged)}</TableCell>
                <TableCell>{formatMinutesAsHours(row.capacityMinutes)}</TableCell>
                <TableCell className="text-right">{row.utilizationPct.toFixed(1)}%</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">
        Capacity is a fixed estimate of 8 hours per weekday (Mon&ndash;Fri) in the selected date
        range, applied uniformly to every technician. It does not reflect a real per-technician
        schedule, PTO, or partial availability.
      </p>
    </div>
  );
}
