import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import {
  getTechnicianUtilization,
  getCurrentMonthRange,
  isValidDateString,
} from "@/lib/reporting";
import { DateRangeFilter } from "@/components/reports/date-range-filter";
import { UtilizationTable } from "@/components/reports/utilization-table";

/**
 * Technician utilization report (/reports/utilization). Gated on
 * can(role, "report:view_own") for baseline access; separately checks
 * can(role, "report:view_all") to decide self-scoped vs. cross-technician
 * rendering (see 05-CONTEXT.md's RBAC decision). Date range comes from
 * searchParams (from/to, YYYY-MM-DD), defaulting to the current calendar
 * month via getCurrentMonthRange() when absent or malformed. This page
 * never constructs Date objects itself -- raw validated/defaulted strings
 * are passed straight to getTechnicianUtilization, which owns all
 * date-boundary parsing (see 05-CONTEXT.md's locked timezone decision).
 */
export default async function UtilizationReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  if (!can(user.role, "report:view_own")) {
    redirect("/unauthorized");
  }

  const params = await searchParams;

  const defaultRange = getCurrentMonthRange();
  const from =
    params.from && isValidDateString(params.from) ? params.from : defaultRange.from;
  const to = params.to && isValidDateString(params.to) ? params.to : defaultRange.to;

  const canViewAll = can(user.role, "report:view_all");

  const rows = canViewAll
    ? await getTechnicianUtilization(from, to)
    : await getTechnicianUtilization(from, to, user.id);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          {canViewAll ? "Technician Utilization" : "My Utilization"}
        </h1>
      </div>

      <DateRangeFilter from={from} to={to} basePath="/reports/utilization" />

      <UtilizationTable rows={rows} />
    </div>
  );
}
