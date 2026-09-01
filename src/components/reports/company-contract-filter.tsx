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
 * does not fetch anything itself; the company list and the (already
 * company-scoped) contract list are fetched by the parent Server Component
 * and passed in as props, matching the plan's required props signature.
 *
 * On change, navigates via `useRouter().push`, preserving the existing
 * `from`/`to` date-range query params (read from the current URL at
 * navigation time) while updating `companyId`/`contractId`. Selecting "none"
 * strips the corresponding query param (rather than passing the literal
 * sentinel string through as a query param value). Changing/clearing the
 * company also strips any previously-selected `contractId`, since a
 * contract belongs to exactly one company. The contract select is only
 * rendered once a company is selected -- a contract cannot be chosen without
 * first scoping to its owning company.
 */
export function CompanyContractFilter({
  companies,
  contracts,
  selectedCompanyId,
  selectedContractId,
  basePath,
}: {
  companies: { id: string; name: string }[];
  contracts: { id: string; label: string }[];
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

  function handleContractChange(value: string) {
    const contractId = value === NONE_VALUE ? undefined : value;
    const query = buildParams({ companyId: selectedCompanyId, contractId });
    router.push(`${basePath}${query ? `?${query}` : ""}`);
  }

  const selectedContractLabel = contracts.find((c) => c.id === selectedContractId)?.label;

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
      {selectedCompanyId && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="contractId">Contract</Label>
          <Select
            value={selectedContractId ?? NONE_VALUE}
            onValueChange={handleContractChange}
          >
            <SelectTrigger id="contractId" className="w-56">
              <SelectValue placeholder="All contracts" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>All contracts</SelectItem>
              {contracts.map((contract) => (
                <SelectItem key={contract.id} value={contract.id}>
                  {contract.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {selectedContractId && selectedContractLabel && (
        <p className="text-sm text-muted-foreground">
          Contract filter active ({selectedContractLabel})
        </p>
      )}
    </div>
  );
}
