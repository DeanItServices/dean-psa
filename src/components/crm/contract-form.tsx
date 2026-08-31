"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createContract } from "@/lib/actions/contracts";
import { isNextRedirectError } from "@/lib/is-next-redirect-error";

type BillingType = "block_hour" | "flat_fee" | "hourly_breakfix";

const BILLING_TYPE_OPTIONS: { value: BillingType; label: string }[] = [
  { value: "block_hour", label: "Block Hours" },
  { value: "flat_fee", label: "Flat Fee" },
  { value: "hourly_breakfix", label: "Hourly Break-Fix" },
];

/**
 * Add-contract form, embedded in ContractsTab. Calls createContract (a
 * Server Action) directly on submit, following the same client-state
 * pattern as CompanyForm/SiteForm.
 *
 * The billing-type-specific amount/rate field is rendered conditionally --
 * only the one input matching the currently selected billingType is shown
 * -- and each field has its own piece of state (blockHours/flatFeeAmount/
 * hourlyRate). Switching billingType does not submit the OTHER fields'
 * stale values because only the field matching the current billingType is
 * ever appended to the FormData on submit (see handleSubmit below) -- so a
 * value typed into, say, flatFeeAmount before switching to block_hour is
 * simply never sent once hourlyRate/blockHours is the active field.
 */
export function ContractForm({ companyId }: { companyId: string }) {
  const [billingType, setBillingType] = React.useState<BillingType>("block_hour");
  const [blockHours, setBlockHours] = React.useState("");
  const [flatFeeAmount, setFlatFeeAmount] = React.useState("");
  const [hourlyRate, setHourlyRate] = React.useState("");
  const [startDate, setStartDate] = React.useState("");
  const [endDate, setEndDate] = React.useState("");
  const [slaResponseMinutes, setSlaResponseMinutes] = React.useState("");
  const [slaResolutionMinutes, setSlaResolutionMinutes] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  function handleBillingTypeChange(value: string) {
    const next = value as BillingType;
    setBillingType(next);
    // Clear the other types' now-irrelevant fields so a stale value from a
    // previously-selected billing type is never submitted for the wrong
    // type (see plan's edge cases).
    setBlockHours("");
    setFlatFeeAmount("");
    setHourlyRate("");
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const formData = new FormData();
      formData.set("billingType", billingType);
      formData.set("startDate", startDate);
      if (endDate) formData.set("endDate", endDate);
      if (slaResponseMinutes) formData.set("slaResponseMinutes", slaResponseMinutes);
      if (slaResolutionMinutes) formData.set("slaResolutionMinutes", slaResolutionMinutes);

      if (billingType === "block_hour") {
        formData.set("blockHours", blockHours);
      } else if (billingType === "flat_fee") {
        formData.set("flatFeeAmount", flatFeeAmount);
      } else if (billingType === "hourly_breakfix") {
        formData.set("hourlyRate", hourlyRate);
      }

      const result = await createContract(companyId, formData);
      if (result?.error) {
        setError(result.error);
        return;
      }

      setBlockHours("");
      setFlatFeeAmount("");
      setHourlyRate("");
      setStartDate("");
      setEndDate("");
      setSlaResponseMinutes("");
      setSlaResolutionMinutes("");
    } catch (err) {
      if (isNextRedirectError(err)) {
        throw err;
      }
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 max-w-md">
      <div className="flex flex-col gap-2">
        <Label htmlFor="billingType">Billing type</Label>
        <Select value={billingType} onValueChange={handleBillingTypeChange}>
          <SelectTrigger id="billingType" className="w-full">
            <SelectValue placeholder="Select billing type" />
          </SelectTrigger>
          <SelectContent>
            {BILLING_TYPE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {billingType === "block_hour" && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="blockHours">Block hours</Label>
          <Input
            id="blockHours"
            name="blockHours"
            type="number"
            min="1"
            step="1"
            required
            value={blockHours}
            onChange={(event) => setBlockHours(event.target.value)}
          />
        </div>
      )}

      {billingType === "flat_fee" && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="flatFeeAmount">Flat fee amount</Label>
          <Input
            id="flatFeeAmount"
            name="flatFeeAmount"
            type="number"
            min="0.01"
            step="0.01"
            required
            value={flatFeeAmount}
            onChange={(event) => setFlatFeeAmount(event.target.value)}
          />
        </div>
      )}

      {billingType === "hourly_breakfix" && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="hourlyRate">Hourly rate</Label>
          <Input
            id="hourlyRate"
            name="hourlyRate"
            type="number"
            min="0.01"
            step="0.01"
            required
            value={hourlyRate}
            onChange={(event) => setHourlyRate(event.target.value)}
          />
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="startDate">Start date</Label>
        <Input
          id="startDate"
          name="startDate"
          type="date"
          required
          value={startDate}
          onChange={(event) => setStartDate(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="endDate">End date</Label>
        <Input
          id="endDate"
          name="endDate"
          type="date"
          value={endDate}
          onChange={(event) => setEndDate(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="slaResponseMinutes">SLA response target (minutes)</Label>
        <Input
          id="slaResponseMinutes"
          name="slaResponseMinutes"
          type="number"
          min="1"
          step="1"
          value={slaResponseMinutes}
          onChange={(event) => setSlaResponseMinutes(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="slaResolutionMinutes">SLA resolution target (minutes)</Label>
        <Input
          id="slaResolutionMinutes"
          name="slaResolutionMinutes"
          type="number"
          min="1"
          step="1"
          value={slaResolutionMinutes}
          onChange={(event) => setSlaResolutionMinutes(event.target.value)}
        />
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Adding..." : "Add contract"}
      </Button>
    </form>
  );
}
