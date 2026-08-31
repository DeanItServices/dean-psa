/**
 * Standalone Microsoft Graph API email-to-ticket poller.
 *
 * Polls a shared mailbox (Microsoft 365 / Exchange Online) via the
 * Microsoft Graph API on a 1-2 minute interval, creating a Ticket
 * (source: "email") + an initial non-internal TicketComment for each
 * new inbound message. Runs as its own process (see the "email-poller"
 * npm script and the "email-poller" Docker Compose service) -- it is
 * NOT part of the Next.js app and does not share its request lifecycle.
 *
 * Per the user's explicit correction during Phase 3 planning (recorded
 * in 03-CONTEXT.md and cross-session memory `email-ingestion-graph-api`),
 * this uses the Microsoft Graph API exclusively. IMAP is not implemented
 * and must not be added here.
 *
 * Plan 03-04 extends this file with a proactive SLA breach-check pass
 * (checkSlaBreaches()) that runs on the same tick as pollOnce()'s email
 * ingestion -- see checkSlaBreaches() below. No second setInterval or
 * scheduled process is introduced for this.
 */

import { ClientSecretCredential } from "@azure/identity";
import { Client } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials";
import fs from "node:fs";
import path from "node:path";

import { db } from "../src/lib/db";
import { computeSlaDeadlines, getSlaStatus } from "../src/lib/sla";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 90_000; // 90s -- within the 1-2 minute range from 03-CONTEXT.md

const WATERMARK_FILE = path.join(process.cwd(), ".email-poller-state.json");

/**
 * Fixed, greppable marker string prefixed to every SLA breach-flag comment.
 * The re-notification guard checks ALL of a ticket's existing comments for
 * this marker before creating a new one -- never re-flag an already-flagged
 * breach on a subsequent tick. Do not change this string without considering
 * that any comment already in the database used it to represent "already
 * flagged."
 */
const SLA_BREACH_MARKER = "[SLA BREACH]";

/** Required environment variables. Fail fast and loud if any is missing. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[email-poller] Missing required environment variable: ${name}. ` +
        `Set AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, and MAILBOX_ADDRESS before starting the poller.`,
    );
  }
  return value;
}

const AZURE_TENANT_ID = requireEnv("AZURE_TENANT_ID");
const AZURE_CLIENT_ID = requireEnv("AZURE_CLIENT_ID");
const AZURE_CLIENT_SECRET = requireEnv("AZURE_CLIENT_SECRET");
const MAILBOX_ADDRESS = requireEnv("MAILBOX_ADDRESS");

// ---------------------------------------------------------------------------
// Graph client
// ---------------------------------------------------------------------------

const credential = new ClientSecretCredential(
  AZURE_TENANT_ID,
  AZURE_CLIENT_ID,
  AZURE_CLIENT_SECRET,
);

const authProvider = new TokenCredentialAuthenticationProvider(credential, {
  // Application-permission scope for app-only auth via client credentials flow.
  scopes: ["https://graph.microsoft.com/.default"],
});

const graphClient = Client.initWithMiddleware({ authProvider });

// ---------------------------------------------------------------------------
// Watermark persistence (last-polled timestamp)
// ---------------------------------------------------------------------------

type PollerState = {
  lastPolledAt: string; // ISO 8601
};

function loadWatermark(): Date {
  try {
    if (fs.existsSync(WATERMARK_FILE)) {
      const raw = fs.readFileSync(WATERMARK_FILE, "utf-8");
      const state = JSON.parse(raw) as PollerState;
      const parsed = new Date(state.lastPolledAt);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
  } catch (err) {
    console.error(
      "[email-poller] Failed to read watermark file, starting from now():",
      err,
    );
  }

  // First run (or unreadable state file): do not backfill historical mail.
  return new Date();
}

function saveWatermark(date: Date): void {
  const state: PollerState = { lastPolledAt: date.toISOString() };
  fs.writeFileSync(WATERMARK_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Graph message shape (subset used by this poller)
// ---------------------------------------------------------------------------

type GraphEmailAddress = {
  emailAddress?: {
    name?: string;
    address?: string;
  };
};

type GraphMessage = {
  id: string;
  subject?: string;
  receivedDateTime: string;
  from?: GraphEmailAddress;
  bodyPreview?: string;
  body?: {
    contentType?: string;
    content?: string;
  };
};

type GraphMessagesResponse = {
  value: GraphMessage[];
};

/**
 * Fetches messages received strictly after `since`, ordered ascending by
 * receivedDateTime, so they are processed and watermarked in chronological
 * order.
 */
async function fetchNewMessages(since: Date): Promise<GraphMessage[]> {
  const filter = `receivedDateTime gt ${since.toISOString()}`;

  try {
    const response = (await graphClient
      .api(`/users/${MAILBOX_ADDRESS}/messages`)
      .filter(filter)
      .orderby("receivedDateTime asc")
      .select("id,subject,receivedDateTime,from,bodyPreview,body")
      .get()) as GraphMessagesResponse;

    return response.value ?? [];
  } catch (err: unknown) {
    // Respect Retry-After on 429s; otherwise let the next scheduled tick
    // (90s later) serve as a natural backoff rather than retrying within
    // this tick, per 03-CONTEXT.md's rate-limit edge case.
    const statusCode = (err as { statusCode?: number })?.statusCode;
    if (statusCode === 429) {
      const retryAfter = (err as { responseHeaders?: Record<string, string> })
        ?.responseHeaders?.["retry-after"];
      console.warn(
        `[email-poller] Graph API rate limited (429).${
          retryAfter ? ` Retry-After: ${retryAfter}s.` : ""
        } Deferring to next scheduled tick.`,
      );
      return [];
    }

    console.error("[email-poller] Failed to fetch messages from Graph API:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Active-contract resolution rule
// (locked verbatim in 03-CONTEXT.md -- shared identically with Plan 03-02's
// createTicket Server Action so both implementations resolve to the exact
// same contract for a given company. Do not reword or reimplement
// differently.)
// ---------------------------------------------------------------------------

async function resolveActiveContract(companyId: string) {
  return db.contract.findFirst({
    where: {
      companyId,
      OR: [{ endDate: null }, { endDate: { gte: new Date() } }],
    },
    orderBy: [{ startDate: "desc" }, { id: "desc" }],
  });
}

// ---------------------------------------------------------------------------
// SLA breach-check pass (Plan 03-04)
// ---------------------------------------------------------------------------
//
// Runs on the SAME tick as email polling (called from within pollOnce()
// below) -- per 03-CONTEXT.md's explicit "SAME poller process, on the same
// tick" decision, no second setInterval or scheduled process is introduced
// here. Detects open tickets that have newly breached their SLA resolution
// deadline and flags each with exactly one guarded internal TicketComment,
// using the marker-string-presence check as the re-notification guard
// (no new schema column -- a schema change is out of scope for this plan).

/** Minimal ticket shape needed by getSlaStatus() plus id/subject for logging
 * and comments for the re-notification guard. */
type BreachCandidateTicket = {
  id: string;
  subject: string;
  status: string;
  slaResponseDeadline: Date | null;
  slaResolutionDeadline: Date | null;
  firstRespondedAt: Date | null;
  resolvedAt: Date | null;
  comments: { body: string }[];
};

/**
 * checkSlaBreaches(): queries open tickets (status not resolved/closed) with
 * a non-null slaResolutionDeadline, uses the shared getSlaStatus() helper
 * (never a second/divergent SLA-status calculation) to determine which are
 * newly breached, and creates exactly one internal "[SLA BREACH]"-marked
 * TicketComment per newly-detected breach. Tickets already carrying such a
 * comment (checked across ALL of their comments, not just the most recent)
 * are skipped so a breach is never re-flagged on every subsequent tick.
 * Tickets with slaResolutionDeadline: null are excluded by the query itself
 * and would additionally never resolve to "breached" via getSlaStatus (it
 * returns "no_sla" for them), so they are never flagged.
 *
 * A single ticket's comment-creation failure (e.g. transient DB error) is
 * caught and logged per-ticket -- it must never crash the whole poller tick.
 */
export async function checkSlaBreaches(): Promise<void> {
  let candidates: BreachCandidateTicket[];

  try {
    candidates = await db.ticket.findMany({
      where: {
        status: { notIn: ["resolved", "closed"] },
        slaResolutionDeadline: { not: null },
      },
      select: {
        id: true,
        subject: true,
        status: true,
        slaResponseDeadline: true,
        slaResolutionDeadline: true,
        firstRespondedAt: true,
        resolvedAt: true,
        comments: { select: { body: true } },
      },
    });
  } catch (err) {
    // If the breach-check query itself fails (e.g. transient DB error), log
    // and skip this tick's breach-check entirely -- do not let it take down
    // email polling, which runs in the same tick.
    console.error(
      "[email-poller] Failed to query open tickets for SLA breach-check, skipping this tick's breach-check:",
      err,
    );
    return;
  }

  for (const ticket of candidates) {
    try {
      const status = getSlaStatus(ticket);
      if (status !== "breached") {
        continue;
      }

      const alreadyFlagged = ticket.comments.some((comment) =>
        comment.body.includes(SLA_BREACH_MARKER),
      );
      if (alreadyFlagged) {
        continue;
      }

      const deadline = ticket.slaResolutionDeadline as Date; // non-null: guaranteed by the query filter above
      await db.ticketComment.create({
        data: {
          ticketId: ticket.id,
          authorId: null,
          isInternal: true,
          body: `${SLA_BREACH_MARKER} This ticket has breached its SLA resolution deadline of ${deadline.toISOString()}.`,
        },
      });

      console.log(
        `[email-poller] SLA breach flagged for ticket ${ticket.id} ("${ticket.subject}"), resolution deadline was ${deadline.toISOString()}.`,
      );
    } catch (err) {
      // A single ticket's flag-creation failure must not crash the whole
      // breach-check pass or the poller tick -- log and continue.
      console.error(
        `[email-poller] Failed to flag SLA breach for ticket ${ticket.id}, skipping:`,
        err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Core poll tick
// ---------------------------------------------------------------------------

/**
 * pollOnce(): fetches new messages since the persisted watermark, attempts
 * to match each sender to an existing Contact, creates a Ticket
 * (source: "email") + initial TicketComment for matched-company messages,
 * and advances/persists the watermark.
 *
 * Structured as a standalone, top-level async function (not inlined into
 * the setInterval callback) so Plan 03-04 can locate and extend it with
 * SLA breach-check logic on the same tick, per 03-CONTEXT.md's design.
 */
export async function pollOnce(): Promise<void> {
  const since = loadWatermark();
  const messages = await fetchNewMessages(since);

  if (messages.length > 0) {
    let latestProcessed = since;

    for (const message of messages) {
      const receivedAt = new Date(message.receivedDateTime);
      if (!Number.isNaN(receivedAt.getTime()) && receivedAt > latestProcessed) {
        latestProcessed = receivedAt;
      }

      try {
        await processMessage(message);
      } catch (err) {
        // A single message failing to process must not crash the poller or
        // block the watermark from advancing past it.
        console.error(
          `[email-poller] Failed to process message ${message.id}, skipping:`,
          err,
        );
      }
    }

    // Persist the watermark after the batch, past every message we attempted
    // (whether ticketed, skipped-unmatched, or errored) so restarts do not
    // reprocess them.
    saveWatermark(latestProcessed);
  }

  // SLA breach-check pass (Plan 03-04): runs on this SAME tick, after email
  // ingestion, as its own guarded step -- see checkSlaBreaches() above. This
  // is unrelated to the watermark (it queries existing Ticket rows, not new
  // Graph messages), so it always runs regardless of whether new email
  // messages were found this tick.
  await checkSlaBreaches();
}

async function processMessage(message: GraphMessage): Promise<void> {
  const senderAddress = message.from?.emailAddress?.address;

  if (!senderAddress) {
    console.warn(
      `[email-poller] Message ${message.id} has no parseable sender address, skipping.`,
    );
    return;
  }

  const contact = await db.contact.findFirst({
    where: { email: senderAddress },
  });

  if (!contact) {
    // Deliberate limitation (locked in 03-CONTEXT.md): Ticket.companyId is
    // required, so a sender with no resolvable Contact/Company cannot be
    // auto-ticketed in this phase. Log and move on -- the watermark still
    // advances past this message so it is not retried forever. Do not
    // invent a "default"/"unknown" company to work around this.
    console.warn(
      `[email-poller] No Contact match for sender ${senderAddress} (message ${message.id}), skipping ticket creation.`,
    );
    return;
  }

  const contract = await resolveActiveContract(contact.companyId);
  const createdAt = new Date();
  const { slaResponseDeadline, slaResolutionDeadline } = computeSlaDeadlines(
    contract
      ? {
          slaResponseMinutes: contract.slaResponseMinutes,
          slaResolutionMinutes: contract.slaResolutionMinutes,
        }
      : null,
    createdAt,
  );

  const bodyContent =
    message.body?.content ?? message.bodyPreview ?? "(no message body)";
  const subject = message.subject ?? "(no subject)";

  const ticket = await db.ticket.create({
    data: {
      companyId: contact.companyId,
      contactId: contact.id,
      contractId: contract?.id ?? null,
      source: "email",
      subject,
      description: bodyContent,
      slaResponseDeadline,
      slaResolutionDeadline,
      createdAt,
    },
  });

  await db.ticketComment.create({
    data: {
      ticketId: ticket.id,
      authorId: null,
      isInternal: false,
      body: bodyContent,
    },
  });

  console.log(
    `[email-poller] Created ticket ${ticket.id} from message ${message.id} (sender: ${senderAddress}, company: ${contact.companyId}).`,
  );
}

// ---------------------------------------------------------------------------
// Process entry point
// ---------------------------------------------------------------------------

function startPolling(): void {
  console.log(
    `[email-poller] Starting. Mailbox: ${MAILBOX_ADDRESS}. Interval: ${POLL_INTERVAL_MS / 1000}s.`,
  );

  // Run an initial tick immediately, then on the fixed interval.
  void pollOnce().catch((err) => {
    console.error("[email-poller] Unhandled error during initial poll:", err);
  });

  setInterval(() => {
    void pollOnce().catch((err) => {
      console.error("[email-poller] Unhandled error during poll tick:", err);
    });
  }, POLL_INTERVAL_MS);
}

// Only auto-start when run directly (not when imported, e.g. by tests or
// by Plan 03-04 extending this module).
if (require.main === module) {
  startPolling();
}
