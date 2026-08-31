"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createAsset } from "@/lib/actions/assets";
import { isNextRedirectError } from "@/lib/is-next-redirect-error";

type SiteOption = { id: string; addressLine1: string };

/**
 * Add-asset form, embedded in AssetsTab. Calls createAsset (a Server
 * Action) directly on submit, following the same client-state pattern as
 * SiteForm/CompanyForm. createAsset revalidates the detail page path on
 * success rather than redirecting, so this component clears its own fields
 * once the action reports success. The site select is optional -- a
 * company with zero sites renders the select with only the "No site"
 * option rather than crashing.
 */
export function AssetForm({
  companyId,
  sites,
}: {
  companyId: string;
  sites: SiteOption[];
}) {
  const [name, setName] = React.useState("");
  const [assetType, setAssetType] = React.useState("");
  const [serialNumber, setSerialNumber] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [siteId, setSiteId] = React.useState<string>("none");
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const formData = new FormData();
      formData.set("name", name);
      formData.set("assetType", assetType);
      formData.set("serialNumber", serialNumber);
      formData.set("notes", notes);
      if (siteId !== "none") formData.set("siteId", siteId);

      const result = await createAsset(companyId, formData);
      if (result?.error) {
        setError(result.error);
        return;
      }

      setName("");
      setAssetType("");
      setSerialNumber("");
      setNotes("");
      setSiteId("none");
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
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          name="name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="assetType">Asset type</Label>
        <Input
          id="assetType"
          name="assetType"
          required
          value={assetType}
          onChange={(event) => setAssetType(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="serialNumber">Serial number</Label>
        <Input
          id="serialNumber"
          name="serialNumber"
          value={serialNumber}
          onChange={(event) => setSerialNumber(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="notes">Notes</Label>
        <Textarea
          id="notes"
          name="notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="siteId">Site</Label>
        <Select value={siteId} onValueChange={setSiteId}>
          <SelectTrigger id="siteId" className="w-full">
            <SelectValue placeholder="No site" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No site</SelectItem>
            {sites.map((site) => (
              <SelectItem key={site.id} value={site.id}>
                {site.addressLine1}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Adding..." : "Add asset"}
      </Button>
    </form>
  );
}
