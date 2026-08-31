/**
 * Pure SLA computation and status-derivation helpers. No database access, no
 * "use server", no side effects -- shared identically by the Kanban board /
 * ticket detail page (Plan 03-02) and the email poller's breach-check tick
 * (Plan 03-04). See 03-CONTEXT.md's Schema decisions and UI/routing
 * decisions sections for the single-shared-implementation rationale.
 */

export type SlaDeadlines = {
  slaResponseDeadline: Date | null;
  slaResolutionDeadline: Date | null;
};

/**
 * Computes a ticket's SLA deadlines from its (already-loaded) contract's SLA
 * minute fields and the ticket's creation time. Called once, at ticket
 * creation, by a later plan's createTicket action -- never re-invoked to
 * recompute deadlines live. Does not query the database and does not mutate
 * either argument.
 */
export function computeSlaDeadlines(
  contract: {
    slaResponseMinutes: number | null;
    slaResolutionMinutes: number | null;
  } | null,
  createdAt: Date,
): SlaDeadlines {
  if (!contract) {
    return { slaResponseDeadline: null, slaResolutionDeadline: null };
  }

  const slaResponseDeadline =
    contract.slaResponseMinutes == null
      ? null
      : new Date(createdAt.getTime() + contract.slaResponseMinutes * 60 * 1000);

  const slaResolutionDeadline =
    contract.slaResolutionMinutes == null
      ? null
      : new Date(createdAt.getTime() + contract.slaResolutionMinutes * 60 * 1000);

  return { slaResponseDeadline, slaResolutionDeadline };
}

export type SlaStatus = "no_sla" | "on_track" | "approaching" | "breached" | "met";

const APPROACHING_WINDOW_MS = 60 * 60 * 1000; // fixed 1-hour-remaining threshold

/**
 * Derives a ticket's SLA status from its own stored fields and the current
 * time. Uses the resolution deadline as the sole status driver (the response
 * deadline is informational only for this phase's badge). Never re-reads
 * Contract or performs any I/O -- must be safe to call both server-side
 * (Kanban rendering) and from the breach-check poller without a guaranteed
 * open database connection.
 */
export function getSlaStatus(
  ticket: {
    status: string;
    slaResponseDeadline: Date | null;
    slaResolutionDeadline: Date | null;
    firstRespondedAt: Date | null;
    resolvedAt: Date | null;
  },
  now?: Date,
): SlaStatus {
  if (ticket.slaResolutionDeadline == null) {
    return "no_sla";
  }

  const deadline = ticket.slaResolutionDeadline.getTime();

  if (ticket.resolvedAt) {
    return ticket.resolvedAt.getTime() <= deadline ? "met" : "breached";
  }

  const nowMs = (now ?? new Date()).getTime();

  if (nowMs >= deadline) {
    return "breached";
  }

  if (nowMs >= deadline - APPROACHING_WINDOW_MS) {
    return "approaching";
  }

  return "on_track";
}
