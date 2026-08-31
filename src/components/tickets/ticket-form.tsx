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
import { createTicket, updateTicket, assignTicket } from "@/lib/actions/tickets";
import { isNextRedirectError } from "@/lib/is-next-redirect-error";

/** Sentinel value for "not set" -- Radix Select's Item cannot use an empty
 * string as its value, mapped back to undefined before the Server Action
 * call, matching src/components/crm/contact-form.tsx's established
 * pattern. */
const NONE_VALUE = "none";

type CompanyOption = { id: string; name: string };
type ContactOption = { id: string; name: string; companyId: string };
type AssetOption = { id: string; name: string; companyId: string };
type UserOption = { id: string; name: string | null; email: string };

type TicketFormValues = {
  id?: string;
  companyId: string;
  contactId: string | null;
  assetId: string | null;
  assignedToId: string | null;
  priority: "low" | "normal" | "high" | "urgent";
  status: "new" | "in_progress" | "waiting_on_client" | "resolved" | "closed";
  subject: string;
  description: string;
};

/**
 * Create/edit ticket form. Follows company-form.tsx's exact pattern:
 * per-field useState, a manually-built FormData passed directly to the
 * Server Action, and isNextRedirectError in the catch block (createTicket
 * redirects server-side on success; updateTicket does not). Contact/Asset
 * selects are filtered to the currently-selected company, matching
 * contact-form.tsx/asset-form.tsx's "none" sentinel pattern for optional
 * relations. Assignee list is all users (unfiltered).
 */
export function TicketForm({
  companies,
  contacts,
  assets,
  users,
  initial,
}: {
  companies: CompanyOption[];
  contacts: ContactOption[];
  assets: AssetOption[];
  users: UserOption[];
  initial?: TicketFormValues;
}) {
  const isEdit = Boolean(initial?.id);

  const [companyId, setCompanyId] = React.useState(initial?.companyId ?? "");
  const [contactId, setContactId] = React.useState(initial?.contactId ?? NONE_VALUE);
  const [assetId, setAssetId] = React.useState(initial?.assetId ?? NONE_VALUE);
  const [assignedToId, setAssignedToId] = React.useState(initial?.assignedToId ?? NONE_VALUE);
  const [priority, setPriority] = React.useState(initial?.priority ?? "normal");
  const [status] = React.useState(initial?.status ?? "new");
  const [subject, setSubject] = React.useState(initial?.subject ?? "");
  const [description, setDescription] = React.useState(initial?.description ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const companyContacts = contacts.filter((c) => c.companyId === companyId);
  const companyAssets = assets.filter((a) => a.companyId === companyId);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const formData = new FormData();
      formData.set("companyId", companyId);
      formData.set("priority", priority);
      formData.set("status", status);
      formData.set("subject", subject);
      formData.set("description", description);
      if (contactId !== NONE_VALUE) formData.set("contactId", contactId);
      if (assetId !== NONE_VALUE) formData.set("assetId", assetId);
      if (assignedToId !== NONE_VALUE) formData.set("assignedToId", assignedToId);

      const result = isEdit && initial?.id
        ? await updateTicket(initial.id, formData)
        : await createTicket(formData);

      if (result?.error) {
        setError(result.error);
      }
    } catch (err) {
      // createTicket calls redirect() internally, which throws a special
      // Next.js redirect error that must be allowed to propagate.
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
        <Label htmlFor="companyId">Company</Label>
        <Select
          value={companyId}
          onValueChange={(value) => {
            setCompanyId(value);
            setContactId(NONE_VALUE);
            setAssetId(NONE_VALUE);
          }}
        >
          <SelectTrigger id="companyId" className="w-full">
            <SelectValue placeholder="Select a company" />
          </SelectTrigger>
          <SelectContent>
            {companies.map((company) => (
              <SelectItem key={company.id} value={company.id}>
                {company.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="subject">Subject</Label>
        <Input
          id="subject"
          name="subject"
          required
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="description">Description</Label>
        <Textarea
          id="description"
          name="description"
          required
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="priority">Priority</Label>
        <Select value={priority} onValueChange={(value) => setPriority(value as typeof priority)}>
          <SelectTrigger id="priority" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="normal">Normal</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="urgent">Urgent</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="contactId">Contact</Label>
        <Select value={contactId} onValueChange={setContactId}>
          <SelectTrigger id="contactId" className="w-full">
            <SelectValue placeholder="No contact" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>No contact</SelectItem>
            {companyContacts.map((contact) => (
              <SelectItem key={contact.id} value={contact.id}>
                {contact.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="assetId">Asset</Label>
        <Select value={assetId} onValueChange={setAssetId}>
          <SelectTrigger id="assetId" className="w-full">
            <SelectValue placeholder="No asset" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>No asset</SelectItem>
            {companyAssets.map((asset) => (
              <SelectItem key={asset.id} value={asset.id}>
                {asset.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="assignedToId">Assignee</Label>
        <Select value={assignedToId} onValueChange={setAssignedToId}>
          <SelectTrigger id="assignedToId" className="w-full">
            <SelectValue placeholder="Unassigned" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>Unassigned</SelectItem>
            {users.map((user) => (
              <SelectItem key={user.id} value={user.id}>
                {user.name ?? user.email}
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
      <Button type="submit" disabled={isSubmitting || !companyId}>
        {isSubmitting ? "Saving..." : isEdit ? "Save changes" : "Create ticket"}
      </Button>
    </form>
  );
}

/**
 * Ticket assignment control for the detail page. A small standalone client
 * island (kept in this already-"use client" module rather than a new file,
 * since files_modified for this plan does not list a separate
 * assign-control component) that calls assignTicket directly on change.
 * The detail page only renders this for users with ticket:assign
 * (dispatcher, admin) -- this component performs no client-side role check
 * itself, since assignTicket is authoritatively RBAC-gated server-side via
 * TICKET_ASSIGN_ROLES regardless of what renders client-side.
 */
export function AssignmentControl({
  ticketId,
  assignedToId,
  users,
}: {
  ticketId: string;
  assignedToId: string | null;
  users: UserOption[];
}) {
  const [value, setValue] = React.useState(assignedToId ?? NONE_VALUE);
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  async function handleChange(next: string) {
    setValue(next);
    setError(null);
    setIsSubmitting(true);

    try {
      const result = await assignTicket(ticketId, next === NONE_VALUE ? null : next);
      if (result?.error) {
        setError(result.error);
        setValue(assignedToId ?? NONE_VALUE);
      }
    } catch (err) {
      if (isNextRedirectError(err)) {
        throw err;
      }
      setError("Something went wrong. Please try again.");
      setValue(assignedToId ?? NONE_VALUE);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="assign">Assigned to</Label>
      <Select value={value} onValueChange={handleChange} disabled={isSubmitting}>
        <SelectTrigger id="assign" className="w-full">
          <SelectValue placeholder="Unassigned" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE_VALUE}>Unassigned</SelectItem>
          {users.map((user) => (
            <SelectItem key={user.id} value={user.id}>
              {user.name ?? user.email}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
