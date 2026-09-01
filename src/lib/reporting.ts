/**
 * Reporting query-helper module for Phase 5 (Technician Utilization, SLA
 * Compliance, Client Profitability). Unlike the fully pure modules
 * `src/lib/sla.ts` / `src/lib/billing.ts` / `src/lib/timer.ts`, this module
 * DOES import `db` from `@/lib/db` and performs real Prisma aggregation
 * queries -- reports fundamentally require database access. It is NOT a
 * Server Action file: no `"use server"` directive, no mutations, just plain
 * exported async read functions. It lives in `src/lib/` (not
 * `src/lib/actions/`) because the "no `"use server"` = not a Server Action"
 * convention still applies; it is simply a DB-backed query-helper module
 * rather than a pure computation module. See 05-CONTEXT.md's "Query helper
 * module decision" for the full rationale behind this distinction.
 */

import { db } from "@/lib/db";
import { TIME_ENTRY_MANAGE_ROLES } from "@/lib/permissions";

// ---------------------------------------------------------------------------
// Date-range boundary helpers
// ---------------------------------------------------------------------------

/**
 * Parses raw `YYYY-MM-DD` strings (as produced by an `<input type="date">`
 * element) into LOCAL start-of-day / end-of-day `Date` boundaries.
 *
 * Deliberately uses the `Date` constructor's numeric-args form (always
 * interpreted as local time by the JS runtime) rather than string-parsing
 * an ISO-formatted string, and NEVER appends a `Z`/UTC suffix -- per
 * 05-CONTEXT.md's locked "Date/timezone handling decision". Naive
 * `new Date("2026-08-31")` parsing produces UTC midnight, which is *before*
 * local midnight in any timezone west of UTC and would silently exclude the
 * final day's local-timezone activity from an inclusive "to" boundary.
 *
 * `from` becomes local `00:00:00.000`; `to` becomes local `23:59:59.999`.
 * This function owns date-boundary interpretation for all three report
 * query functions below -- callers (Wave 2 pages) pass raw `from`/`to`
 * strings through rather than constructing their own `Date` boundaries.
 */
export function parseDateRangeBoundaries(from: string, to: string): { fromDate: Date; toDate: Date } {
  const [fromYear, fromMonth, fromDay] = from.split("-").map(Number);
  const [toYear, toMonth, toDay] = to.split("-").map(Number);

  const fromDate = new Date(fromYear, fromMonth - 1, fromDay, 0, 0, 0, 0);
  const toDate = new Date(toYear, toMonth - 1, toDay, 23, 59, 59, 999);

  return { fromDate, toDate };
}

/**
 * Returns the first and last day of the CURRENT local calendar month as
 * `YYYY-MM-DD` strings, for report pages to use as their default date range
 * when `searchParams` omits `from`/`to`.
 */
export function getCurrentMonthRange(): { from: string; to: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);

  const format = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  return { from: format(firstDay), to: format(lastDay) };
}

/**
 * Counts Monday-Friday days, inclusive of both endpoints, between two Date
 * boundaries. Internal helper for the fixed-capacity utilization constant
 * (see 05-CONTEXT.md's "Utilization capacity decision" -- 8 hours/weekday,
 * not a real per-technician schedule). Not exported.
 */
function countWeekdays(fromDate: Date, toDate: Date): number {
  let count = 0;
  const cursor = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  const end = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate());

  while (cursor.getTime() <= end.getTime()) {
    const dayOfWeek = cursor.getDay(); // 0 = Sunday, 6 = Saturday
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      count += 1;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return count;
}

// ---------------------------------------------------------------------------
// Technician utilization
// ---------------------------------------------------------------------------

export interface UtilizationRow {
  userId: string;
  userName: string;
  minutesLogged: number;
  capacityMinutes: number;
  utilizationPct: number;
}

/**
 * Returns per-technician logged-minutes vs. fixed capacity for the given
 * date range.
 *
 * "Capacity" is a fixed constant -- 8 hours/weekday x the number of Mon-Fri
 * days in the selected range, applied uniformly to every technician --
 * since no real capacity/schedule model exists anywhere in the schema. This
 * is a deliberate simplification, not a hidden assumption (see
 * 05-CONTEXT.md's "Utilization capacity decision"); it does not account for
 * a technician joining mid-range, PTO, or partial availability.
 *
 * If `userId` is provided, returns a single-row array scoped to that user
 * (0 minutes if they logged nothing in range -- never an empty array for a
 * valid self-view). If `userId` is omitted, returns the cross-technician
 * view: EVERY user whose role is in `TIME_ENTRY_MANAGE_ROLES`, including
 * technicians with zero logged minutes in range -- a 0%-utilization
 * technician is the most actionable row for a manager and must not be
 * silently omitted (see 05-CONTEXT.md's "Utilization completeness
 * decision"). Sorted by `userName` ascending.
 *
 * Only completed `TimeEntry` rows (`endedAt IS NOT NULL`) count toward
 * logged minutes -- a currently-running timer has no `durationMinutes` yet
 * and must not be summed.
 */
export async function getTechnicianUtilization(
  from: string,
  to: string,
  userId?: string,
): Promise<UtilizationRow[]> {
  const { fromDate, toDate } = parseDateRangeBoundaries(from, to);
  const capacityMinutes = 8 * 60 * countWeekdays(fromDate, toDate);

  // Eligible-user list: a single user (self-view) or every
  // TIME_ENTRY_MANAGE_ROLES user (cross-technician view).
  const eligibleUsers = userId
    ? await db.user.findMany({ where: { id: userId }, select: { id: true, name: true } })
    : await db.user.findMany({
        where: { role: { in: TIME_ENTRY_MANAGE_ROLES } },
        select: { id: true, name: true },
      });

  if (eligibleUsers.length === 0) {
    return [];
  }

  const eligibleUserIds = eligibleUsers.map((u) => u.id);

  const grouped = await db.timeEntry.groupBy({
    by: ["userId"],
    where: {
      userId: { in: eligibleUserIds },
      startedAt: { gte: fromDate, lte: toDate },
      endedAt: { not: null },
    },
    _sum: { durationMinutes: true },
  });

  const minutesByUserId = new Map<string, number>();
  for (const row of grouped) {
    if (row.userId != null) {
      minutesByUserId.set(row.userId, row._sum.durationMinutes ?? 0);
    }
  }

  const rows: UtilizationRow[] = eligibleUsers.map((user) => {
    const minutesLogged = minutesByUserId.get(user.id) ?? 0;
    return {
      userId: user.id,
      userName: user.name ?? "(unnamed user)",
      minutesLogged,
      capacityMinutes,
      utilizationPct: capacityMinutes > 0 ? (minutesLogged / capacityMinutes) * 100 : 0,
    };
  });

  rows.sort((a, b) => a.userName.localeCompare(b.userName));

  return rows;
}

// ---------------------------------------------------------------------------
// SLA compliance
// ---------------------------------------------------------------------------

export interface SlaComplianceResult {
  responseMet: number;
  responseBreached: number;
  responseCompliancePct: number | null;
  resolutionMet: number;
  resolutionBreached: number;
  resolutionCompliancePct: number | null;
}

/**
 * Computes response-leg and resolution-leg SLA compliance counts for
 * tickets created within the given date range, optionally filtered by
 * company and/or contract.
 *
 * A ticket with a null `slaResponseDeadline`/`slaResolutionDeadline` (no
 * contract, or a contract without that SLA field set) is excluded from that
 * leg's denominator entirely -- neither met nor breached -- matching
 * `src/lib/sla.ts`'s `getSlaStatus` "no_sla" precedent. An unresolved
 * ticket still within its deadline is also excluded (neither met nor
 * breached yet); only tickets with an unambiguous final outcome count.
 *
 * The breach condition uses the EXACT nested AND/OR grouping locked in
 * 05-CONTEXT.md (supersedes an earlier, ambiguously-flattened draft):
 *   breached = slaResponseDeadline IS NOT NULL AND (
 *     (firstRespondedAt IS NULL AND slaResponseDeadline < now())
 *     OR
 *     (firstRespondedAt IS NOT NULL AND firstRespondedAt > slaResponseDeadline)
 *   )
 * Mirrored identically for the resolution leg using
 * slaResolutionDeadline/resolvedAt. Compliance % is `met / (met + breached)
 * * 100`, or `null` (not 0) when the leg has no denominator.
 */
export async function getSlaCompliance(
  from: string,
  to: string,
  companyId?: string,
  contractId?: string,
): Promise<SlaComplianceResult> {
  const { fromDate, toDate } = parseDateRangeBoundaries(from, to);
  const now = new Date();

  const baseWhere = {
    createdAt: { gte: fromDate, lte: toDate },
    ...(companyId && { companyId }),
    ...(contractId && { contractId }),
  };

  // The met/breached classification below compares two columns on the SAME
  // row (e.g. firstRespondedAt <= slaResponseDeadline), which Prisma's
  // standard filter API cannot express as a `where` clause (no
  // field-to-field comparison operator). Fetch every ticket in range that
  // has at least one SLA deadline set, then classify each leg in JS using
  // the exact nested AND/OR precedence locked in 05-CONTEXT.md.
  const candidateTickets = await db.ticket.findMany({
    where: {
      ...baseWhere,
      OR: [{ slaResponseDeadline: { not: null } }, { slaResolutionDeadline: { not: null } }],
    },
    select: {
      slaResponseDeadline: true,
      slaResolutionDeadline: true,
      firstRespondedAt: true,
      resolvedAt: true,
    },
  });

  let respMet = 0;
  let respBreached = 0;
  let resoMet = 0;
  let resoBreached = 0;

  for (const ticket of candidateTickets) {
    // Response leg
    if (ticket.slaResponseDeadline !== null) {
      const deadline = ticket.slaResponseDeadline;
      if (ticket.firstRespondedAt !== null && ticket.firstRespondedAt <= deadline) {
        respMet += 1;
      } else if (
        (ticket.firstRespondedAt === null && deadline < now) ||
        (ticket.firstRespondedAt !== null && ticket.firstRespondedAt > deadline)
      ) {
        respBreached += 1;
      }
      // else: unresolved leg still within deadline -- excluded from both.
    }

    // Resolution leg
    if (ticket.slaResolutionDeadline !== null) {
      const deadline = ticket.slaResolutionDeadline;
      if (ticket.resolvedAt !== null && ticket.resolvedAt <= deadline) {
        resoMet += 1;
      } else if (
        (ticket.resolvedAt === null && deadline < now) ||
        (ticket.resolvedAt !== null && ticket.resolvedAt > deadline)
      ) {
        resoBreached += 1;
      }
      // else: unresolved leg still within deadline -- excluded from both.
    }
  }

  const responseDenominator = respMet + respBreached;
  const resolutionDenominator = resoMet + resoBreached;

  return {
    responseMet: respMet,
    responseBreached: respBreached,
    responseCompliancePct: responseDenominator > 0 ? (respMet / responseDenominator) * 100 : null,
    resolutionMet: resoMet,
    resolutionBreached: resoBreached,
    resolutionCompliancePct:
      resolutionDenominator > 0 ? (resoMet / resolutionDenominator) * 100 : null,
  };
}

// ---------------------------------------------------------------------------
// Client profitability
// ---------------------------------------------------------------------------

export interface ProfitabilityRow {
  companyId: string;
  companyName: string;
  billedRevenue: number;
  hoursInvested: number;
}

/**
 * Returns billed revenue vs. hours invested per company for the given date
 * range, optionally filtered by company and/or contract.
 *
 * Revenue half: a real Prisma `groupBy` on `Invoice.companyId` (a direct
 * field on `Invoice`, so this groupBy is valid), summing `total` for
 * non-draft invoices whose billing period OVERLAPS the query range --
 * `periodStart <= toDate AND periodEnd >= fromDate`, NOT full-containment
 * (see 05-CONTEXT.md's locked "Invoice period-overlap decision"; the
 * original full-containment condition silently excluded partially
 * overlapping invoices, understating revenue for non-calendar-aligned
 * billing cycles). Every `Decimal` `_sum.total` is converted via
 * `.toNumber()` before any arithmetic -- summing raw `Decimal` objects with
 * `+` produces a wrong/coerced result, not a compile error.
 *
 * Hours half: `TimeEntry` has NO direct `companyId` column (only reachable
 * via `TimeEntry.ticket.companyId`), so `db.timeEntry.groupBy({ by:
 * ["companyId"] })` is invalid and MUST NOT be used (see 05-CONTEXT.md's
 * locked "Prisma groupBy cross-model limitation"). Instead this queries
 * `findMany` with a `select` reaching through `ticket.companyId`, then
 * reduces the results into a `Map<companyId, totalMinutes>` in JS.
 *
 * Both maps are merged by `companyId` -- a company present in only one map
 * still appears, with the other value defaulting to 0. `hoursInvested` is
 * reported strictly as a raw hours figure and is NEVER converted to or
 * blended with a dollar amount, for every contract billing type uniformly
 * (see 05-CONTEXT.md's revised "Client profitability cost decision" --
 * `Contract.hourlyRate` is only ever set on `hourly_breakfix` contracts, so
 * a $0-per-hour fallback for flat-fee/block-hour contracts would actively
 * invert the picture for the common case rather than merely omit a
 * nice-to-have). Sorted by `companyName` ascending.
 */
export async function getClientProfitability(
  from: string,
  to: string,
  companyId?: string,
  contractId?: string,
): Promise<ProfitabilityRow[]> {
  const { fromDate, toDate } = parseDateRangeBoundaries(from, to);

  // Revenue half: real groupBy on Invoice.companyId (a direct field).
  // Period-OVERLAP condition, not full-containment.
  const revenueGroups = await db.invoice.groupBy({
    by: ["companyId"],
    where: {
      status: { not: "draft" },
      periodStart: { lte: toDate },
      periodEnd: { gte: fromDate },
      ...(companyId && { companyId }),
      ...(contractId && { contractId }),
    },
    _sum: { total: true },
  });

  const revenueByCompanyId = new Map<string, number>();
  for (const group of revenueGroups) {
    revenueByCompanyId.set(group.companyId, group._sum.total?.toNumber() ?? 0);
  }

  // Hours half: TimeEntry has no direct companyId column -- findMany +
  // JS reduce through ticket.companyId, never an invalid cross-model
  // groupBy.
  const timeEntries = await db.timeEntry.findMany({
    where: {
      startedAt: { gte: fromDate, lte: toDate },
      isBillable: true,
      endedAt: { not: null },
      ...(contractId && { contractId }),
    },
    select: {
      durationMinutes: true,
      ticket: { select: { companyId: true } },
    },
  });

  const minutesByCompanyId = new Map<string, number>();
  for (const entry of timeEntries) {
    const entryCompanyId = entry.ticket.companyId;
    if (companyId && entryCompanyId !== companyId) {
      continue;
    }
    const current = minutesByCompanyId.get(entryCompanyId) ?? 0;
    minutesByCompanyId.set(entryCompanyId, current + (entry.durationMinutes ?? 0));
  }

  // Merge both maps by companyId -- a company present in only one map still
  // appears, with the other value defaulting to 0.
  const allCompanyIds = new Set<string>([
    ...revenueByCompanyId.keys(),
    ...minutesByCompanyId.keys(),
  ]);

  if (allCompanyIds.size === 0) {
    return [];
  }

  const companies = await db.company.findMany({
    where: { id: { in: Array.from(allCompanyIds) } },
    select: { id: true, name: true },
  });
  const nameByCompanyId = new Map(companies.map((c) => [c.id, c.name]));

  const rows: ProfitabilityRow[] = Array.from(allCompanyIds).map((id) => ({
    companyId: id,
    companyName: nameByCompanyId.get(id) ?? "(unknown company)",
    billedRevenue: revenueByCompanyId.get(id) ?? 0,
    hoursInvested: (minutesByCompanyId.get(id) ?? 0) / 60,
  }));

  rows.sort((a, b) => a.companyName.localeCompare(b.companyName));

  return rows;
}
