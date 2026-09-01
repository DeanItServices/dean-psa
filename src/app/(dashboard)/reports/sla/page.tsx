import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { db } from "@/lib/db";
import { getSlaCompliance, getCurrentMonthRange, isValidDateString } from "@/lib/reporting";
import { DateRangeFilter } from "@/components/reports/date-range-filter";
import { CompanyContractFilter } from "@/components/reports/company-contract-filter";
import { SlaComplianceSummary } from "@/components/reports/sla-compliance-summary";

const BILLING_TYPE_LABELS: Record<string, string> = {
  block_hour: "Block Hours",
  flat_fee: "Flat Fee",
  hourly_breakfix: "Hourly Break-Fix",
};

function formatContractLabel(contract: { billingType: string; startDate: Date }): string {
  const billingLabel = BILLING_TYPE_LABELS[contract.billingType] ?? contract.billingType;
  const startLabel = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
    contract.startDate,
  );
  return `${billingLabel} (started ${startLabel})`;
}

/**
 * SLA compliance report (/reports/sla). Restricted to `report:view_all`
 * roles (dispatcher, finance, admin) -- report:view_own alone is NOT
 * sufficient for this page, matching 05-CONTEXT.md's page-level gate
 * decision (unlike /reports/utilization, this report has no self-scoped
 * fallback view).
 *
 * Null-session-guard precedes any can() call, matching
 * src/app/(dashboard)/invoices/page.tsx's exact established pattern -- this
 * must be the literal first check, before any permission logic, so an
 * expired session redirects cleanly to /login instead of throwing inside
 * can(user.role, ...) on a null user.
 *
 * from/to are parsed as raw strings with a basic YYYY-MM-DD shape check only
 * -- this page never constructs Date objects itself. All date-boundary
 * interpretation (local start-of-day / end-of-day, timezone-safe) is owned
 * by src/lib/reporting.ts per 05-CONTEXT.md's locked timezone decision.
 */
export default async function SlaComplianceReportPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    companyId?: string;
    contractId?: string;
  }>;
}) {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  if (!can(user.role, "report:view_all")) {
    redirect("/unauthorized");
  }

  const params = await searchParams;

  const defaultRange = getCurrentMonthRange();
  const from =
    params.from && isValidDateString(params.from) ? params.from : defaultRange.from;
  const to = params.to && isValidDateString(params.to) ? params.to : defaultRange.to;

  const companyId = params.companyId || undefined;
  const contractId = params.contractId || undefined;

  const companies = await db.company.findMany({
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  const contracts = companyId
    ? await db.contract.findMany({
        where: { companyId },
        select: { id: true, billingType: true, startDate: true },
        orderBy: { startDate: "desc" },
      })
    : [];

  const result = await getSlaCompliance(from, to, companyId, contractId);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">SLA Compliance</h1>
      </div>

      <div className="flex flex-col gap-4">
        <DateRangeFilter from={from} to={to} basePath="/reports/sla" />
        <CompanyContractFilter
          companies={companies}
          contracts={contracts.map((contract) => ({
            id: contract.id,
            label: formatContractLabel(contract),
          }))}
          selectedCompanyId={companyId}
          selectedContractId={contractId}
          basePath="/reports/sla"
        />
      </div>

      <SlaComplianceSummary result={result} />
    </div>
  );
}
