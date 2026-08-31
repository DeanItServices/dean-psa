"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSite } from "@/lib/actions/sites";

/**
 * Add-site form, embedded in SitesTab. Calls createSite (a Server Action)
 * directly on submit, following the same client-state pattern as
 * CompanyForm/LoginPage. createSite revalidates the detail page path on
 * success rather than redirecting, so this component clears its own fields
 * once the action reports success.
 */
export function SiteForm({ companyId }: { companyId: string }) {
  const [addressLine1, setAddressLine1] = React.useState("");
  const [addressLine2, setAddressLine2] = React.useState("");
  const [city, setCity] = React.useState("");
  const [state, setState] = React.useState("");
  const [postalCode, setPostalCode] = React.useState("");
  const [country, setCountry] = React.useState("");
  const [isPrimary, setIsPrimary] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const formData = new FormData();
      formData.set("addressLine1", addressLine1);
      formData.set("addressLine2", addressLine2);
      formData.set("city", city);
      formData.set("state", state);
      formData.set("postalCode", postalCode);
      formData.set("country", country);
      if (isPrimary) formData.set("isPrimary", "on");

      const result = await createSite(companyId, formData);
      if (result?.error) {
        setError(result.error);
        return;
      }

      setAddressLine1("");
      setAddressLine2("");
      setCity("");
      setState("");
      setPostalCode("");
      setCountry("");
      setIsPrimary(false);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 max-w-md">
      <div className="flex flex-col gap-2">
        <Label htmlFor="addressLine1">Address line 1</Label>
        <Input
          id="addressLine1"
          name="addressLine1"
          required
          value={addressLine1}
          onChange={(event) => setAddressLine1(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="addressLine2">Address line 2</Label>
        <Input
          id="addressLine2"
          name="addressLine2"
          value={addressLine2}
          onChange={(event) => setAddressLine2(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="city">City</Label>
        <Input
          id="city"
          name="city"
          required
          value={city}
          onChange={(event) => setCity(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="state">State</Label>
        <Input
          id="state"
          name="state"
          required
          value={state}
          onChange={(event) => setState(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="postalCode">Postal code</Label>
        <Input
          id="postalCode"
          name="postalCode"
          required
          value={postalCode}
          onChange={(event) => setPostalCode(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="country">Country</Label>
        <Input
          id="country"
          name="country"
          required
          value={country}
          onChange={(event) => setCountry(event.target.value)}
        />
      </div>
      <div className="flex items-center gap-2">
        <input
          id="isPrimary"
          name="isPrimary"
          type="checkbox"
          checked={isPrimary}
          onChange={(event) => setIsPrimary(event.target.checked)}
          className="size-4"
        />
        <Label htmlFor="isPrimary">Primary site</Label>
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Adding..." : "Add site"}
      </Button>
    </form>
  );
}
