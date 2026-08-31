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
import { createContact } from "@/lib/actions/contacts";

/** Sentinel value for "no site" -- Radix Select's Item cannot use an empty
 * string as its value, so this is mapped back to undefined before the
 * Server Action call. */
const NO_SITE_VALUE = "none";

type SiteOption = { id: string; addressLine1: string; city: string };

/**
 * Add-contact form, embedded in ContactsTab. Calls createContact (a Server
 * Action) directly on submit, following the same client-state pattern as
 * CompanyForm/SiteForm: per-field useState, a manually-built FormData, and
 * inline role="alert" error text. Renders an optional Site select -- when
 * the company has zero sites, the dropdown still renders with only the
 * "No site" option rather than crashing or being omitted.
 */
export function ContactForm({
  companyId,
  sites,
}: {
  companyId: string;
  sites: SiteOption[];
}) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [siteId, setSiteId] = React.useState(NO_SITE_VALUE);
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const formData = new FormData();
      formData.set("name", name);
      formData.set("email", email);
      formData.set("phone", phone);
      formData.set("title", title);
      if (siteId !== NO_SITE_VALUE) formData.set("siteId", siteId);

      const result = await createContact(companyId, formData);
      if (result?.error) {
        setError(result.error);
        return;
      }

      setName("");
      setEmail("");
      setPhone("");
      setTitle("");
      setSiteId(NO_SITE_VALUE);
    } catch {
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
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="phone">Phone</Label>
        <Input
          id="phone"
          name="phone"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="title">Title</Label>
        <Input
          id="title"
          name="title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="siteId">Site</Label>
        <Select value={siteId} onValueChange={setSiteId}>
          <SelectTrigger id="siteId" className="w-full">
            <SelectValue placeholder="No site" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_SITE_VALUE}>No site</SelectItem>
            {sites.map((site) => (
              <SelectItem key={site.id} value={site.id}>
                {site.addressLine1}, {site.city}
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
        {isSubmitting ? "Adding..." : "Add contact"}
      </Button>
    </form>
  );
}
