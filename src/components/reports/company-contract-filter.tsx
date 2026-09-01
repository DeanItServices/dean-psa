"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Sentinel value for "not set" -- Radix Select's Item cannot use an empty
 * string value, matching the codebase's established nullable-relation-select
 * convention (see ticket-form.tsx / contact-form.tsx / asset-form.tsx). */
const NONE_VALUE = "none";

/**
 * Shared, reusable company/contract filter for report pages (SLA compliance,
 * client profitability). Presentational-only "use client" component -- it
 * does not fetch anything itself; the company list is fetched by the parent
 * Server Component and passed in as a prop, matching the plan's required
 * props signature.
 *
 * On change, navigates via `useRouter().push`, preserving the existing
 * `from`/`to` date-range query params (read from the current URL at
 * navigation time) while updating `companyId`. Selecting "none" strips
 * `companyId` (and, since a contract is scoped to a company, also strips any
 * previously-selected `contractId`) from the resulting URL rather than
 * passing the literal sentinel string through as a query param value.
 */
export function CompanyContractFilter({
  companies,
  selectedCompanyId,
  selectedContractId,
  basePath,
}: {
  companies: { id: string; name: string }[];
  selectedCompanyId?: string;
  selectedContractId?: string;
  basePath: string;
}) {
  const router = useRouter();

  function buildParams(next: { companyId?: string; contractId?: string }): string {
    const params = new URLSearchParams(
      typeof window !== "undefined" ? window.location.search : "",
    );

    if (next.companyId) {
      params.set("companyId", next.companyId);
    } else {
      params.delete("companyId");
    }

    if (next.contractId) {
      params.set("contractId", next.contractId);
    } else {
      params.delete("contractId");
    }

    return params.toString();
  }

  function handleCompanyChange(value: string) {
    const companyId = value === NONE_VALUE ? undefined : value;
    // A contract belongs to a single company -- clearing/changing the
    // company invalidates any previously-selected contract, so it is
    // stripped here rather than carried forward against a new company.
    const query = buildParams({ companyId, contractId: undefined });
    router.push(`${basePath}${query ? `?${query}` : ""}`);
  }

  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="companyId">Company</Label>
        <Select
          value={selectedCompanyId ?? NONE_VALUE}
          onValueChange={handleCompanyChange}
        >
          <SelectTrigger id="companyId" className="w-56">
            <SelectValue placeholder="All companies" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>All companies</SelectItem>
            {companies.map((company) => (
              <SelectItem key={company.id} value={company.id}>
                {company.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {selectedContractId && (
        <p className="text-sm text-muted-foreground">
          Contract filter active ({selectedContractId})
        </p>
      )}
    </div>
  );
}
