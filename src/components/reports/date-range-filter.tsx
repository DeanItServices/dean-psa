"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Shared date-range filter bar for report pages (utilization, SLA
 * compliance, client profitability). Renders two native `<input
 * type="date">` elements plus an Apply button that navigates via
 * `useRouter().push` to `${basePath}?from=...&to=...` -- kept generic via
 * `basePath` so the same component is reused across all three Wave 2 report
 * routes without any report-specific logic living here (see
 * 05-CONTEXT.md's "Date-range filtering decision").
 */
export function DateRangeFilter({
  from,
  to,
  basePath,
}: {
  from: string;
  to: string;
  basePath: string;
}) {
  const router = useRouter();
  const [fromValue, setFromValue] = React.useState(from);
  const [toValue, setToValue] = React.useState(to);

  function handleApply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Guard against an inverted range (from > to), which would otherwise
    // silently navigate to a query that produces an empty report with no
    // explanation. Swap rather than block -- the user's intent (two
    // endpoints of a range) is still honored either way.
    const [effectiveFrom, effectiveTo] =
      fromValue > toValue ? [toValue, fromValue] : [fromValue, toValue];
    router.push(`${basePath}?from=${effectiveFrom}&to=${effectiveTo}`);
  }

  return (
    <form onSubmit={handleApply} className="flex flex-wrap items-end gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="from">From</Label>
        <Input
          id="from"
          name="from"
          type="date"
          value={fromValue}
          onChange={(event) => setFromValue(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="to">To</Label>
        <Input
          id="to"
          name="to"
          type="date"
          value={toValue}
          onChange={(event) => setToValue(event.target.value)}
        />
      </div>
      <Button type="submit">Apply</Button>
    </form>
  );
}
