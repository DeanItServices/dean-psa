import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { db } from "@/lib/db";
import { getClientProfitability, getCurrentMonthRange, isValidDateString } from "@/lib/reporting";
import { DateRangeFilter } from "@/components/reports/date-range-filter";
import { CompanyContractFilter } from "@/components/reports/company-contract-filter";
import { ProfitabilityTable } from "@/components/reports/profitability-table";

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
 * Client profitability report (/reports/profitability). Gated by
 * can(role, "report:view_all") only -- report:view_own alone does not grant
 * access, matching the SLA compliance page's precedent and 05-CONTEXT.md's
 * locked RBAC decision (this report is finance-sensitive; a technician or
 * sales user hitting this route directly is redirected, never shown a
 * partial/empty report).
 *
 * from/to are parsed as raw YYYY-MM-DD strings with only a basic shape
 * check -- no Date construction happens in this file. All date-boundary
 * interpretation is owned by src/lib/reporting.ts's parseDateRangeBoundaries,
 * per 05-CONTEXT.md's locked "Date/timezone handling decision". Malformed or
 * missing from/to fall back to getCurrentMonthRange() per field.
 */
export default async function ProfitabilityReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; companyId?: string; contractId?: string }>;
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

  const rows = await getClientProfitability(from, to, companyId, contractId);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Client Profitability</h1>
      </div>

      <div className="flex flex-col gap-4">
        <DateRangeFilter from={from} to={to} basePath="/reports/profitability" />
        <CompanyContractFilter
          companies={companies}
          contracts={contracts.map((contract) => ({
            id: contract.id,
            label: formatContractLabel(contract),
          }))}
          selectedCompanyId={companyId}
          selectedContractId={contractId}
          basePath="/reports/profitability"
        />
      </div>

      <ProfitabilityTable rows={rows} />
    </div>
  );
}
