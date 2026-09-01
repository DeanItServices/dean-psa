"use client";

import * as React from "react";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { updateTimeEntry, deleteTimeEntry } from "@/lib/actions/time-entries";
import { formatDuration } from "@/lib/timer";
import { isNextRedirectError } from "@/lib/is-next-redirect-error";

const COLUMN_COUNT = 6;

export type TimeEntryRow = {
  id: string;
  technicianName: string;
  durationMinutes: number | null;
  isBillable: boolean;
  notes: string | null;
  isRunning: boolean;
  isInvoiced: boolean;
};

/**
 * One editable row in the time entry table. Kept as a sub-component so each
 * row owns its own local edit/pending state independently of its siblings.
 * Invoiced entries (isInvoiced) render fully read-only -- no edit controls,
 * matching this plan's explicit "invoiced entries are not editable/
 * deletable" requirement (invoice creation itself is out of scope for this
 * plan; invoiceLineItemId is read-only context here).
 */
function TimeEntryRowView({
  entry,
  canManage,
}: {
  entry: TimeEntryRow;
  canManage: boolean;
}) {
  const [isBillable, setIsBillable] = React.useState(entry.isBillable);
  const [notes, setNotes] = React.useState(entry.notes ?? "");
  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const editable = canManage && !entry.isInvoiced;

  function handleBillableChange(checked: boolean) {
    setIsBillable(checked);
    setError(null);
    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.set("isBillable", checked ? "on" : "off");
        formData.set("notes", notes);
        const result = await updateTimeEntry(entry.id, formData);
        if (result?.error) {
          setError(result.error);
          setIsBillable(entry.isBillable);
        }
      } catch (err) {
        if (isNextRedirectError(err)) {
          throw err;
        }
        setError("Something went wrong. Please try again.");
        setIsBillable(entry.isBillable);
      }
    });
  }

  function handleNotesBlur() {
    if (notes === (entry.notes ?? "")) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.set("isBillable", isBillable ? "on" : "off");
        formData.set("notes", notes);
        const result = await updateTimeEntry(entry.id, formData);
        if (result?.error) {
          setError(result.error);
        }
      } catch (err) {
        if (isNextRedirectError(err)) {
          throw err;
        }
        setError("Something went wrong. Please try again.");
      }
    });
  }

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await deleteTimeEntry(entry.id);
        if (result?.error) {
          setError(result.error);
        }
      } catch (err) {
        if (isNextRedirectError(err)) {
          throw err;
        }
        setError("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <TableRow>
      <TableCell className="font-medium">{entry.technicianName}</TableCell>
      <TableCell>
        {entry.isRunning ? (
          <Badge variant="outline">Running</Badge>
        ) : (
          formatDuration(entry.durationMinutes ?? 0)
        )}
      </TableCell>
      <TableCell>
        <input
          type="checkbox"
          aria-label="Billable"
          checked={isBillable}
          disabled={!editable || isPending}
          onChange={(event) => handleBillableChange(event.target.checked)}
        />
      </TableCell>
      <TableCell className="whitespace-normal">
        {editable ? (
          <input
            type="text"
            className="w-full rounded-md border bg-transparent px-2 py-1 text-sm"
            value={notes}
            disabled={isPending}
            onChange={(event) => setNotes(event.target.value)}
            onBlur={handleNotesBlur}
            placeholder="Notes"
          />
        ) : (
          <span className="text-sm text-muted-foreground">{entry.notes || "—"}</span>
        )}
      </TableCell>
      <TableCell>
        {entry.isInvoiced && <Badge variant="secondary">Invoiced</Badge>}
        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </TableCell>
      <TableCell>
        {editable && !entry.isRunning && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={handleDelete}
          >
            Delete
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * Renders a ticket's time entries as a table: technician, duration,
 * billable toggle, notes, invoiced status, and a delete action. canManage
 * controls whether edit/delete controls render at all -- users without
 * timeentry:manage (e.g. sales, finance viewing ticket:view-only) see a
 * fully read-only table, matching the detail page's gating. Empty-state row
 * sets colSpan to COLUMN_COUNT so it does not visually break the table.
 */
export function TimeEntryList({
  entries,
  canManage,
}: {
  entries: TimeEntryRow[];
  canManage: boolean;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Technician</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Billable</TableHead>
          <TableHead>Notes</TableHead>
          <TableHead>Status</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.length === 0 ? (
          <TableRow>
            <TableCell colSpan={COLUMN_COUNT} className="text-center text-sm text-muted-foreground">
              No time entries yet.
            </TableCell>
          </TableRow>
        ) : (
          entries.map((entry) => (
            <TimeEntryRowView key={entry.id} entry={entry} canManage={canManage} />
          ))
        )}
      </TableBody>
    </Table>
  );
}
