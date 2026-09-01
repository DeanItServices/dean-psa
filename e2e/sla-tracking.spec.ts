import { test, expect } from "@playwright/test";
import { loginAs } from "./fixtures";

/**
 * SLA tracking E2E spec (Plan 06-08).
 *
 * Scope (deliberately limited -- see 06-08-PLAN.md's objective): this spec
 * confirms the UI correctly *surfaces* SLA data that `src/lib/sla.ts`'s
 * `getSlaStatus` and `src/lib/reporting.ts`'s `getSlaCompliance` already
 * compute (both have logic-level regression coverage from Phase 5's
 * review -- 17+ tests). It does NOT attempt to simulate an actual SLA
 * breach, which would require real elapsed wall-clock hours relative to a
 * `slaResolutionMinutes`-derived deadline -- out of scope for a fast,
 * deterministic E2E test.
 *
 * Test data strategy: the seed data (`prisma/seed.ts`) creates zero
 * `Contract` rows -- there is no pre-seeded SLA-bearing contract to rely on.
 * This spec creates its own Company + SLA-bearing Contract via the real CRM
 * UI, then creates a Ticket against that company via the real ticket-create
 * UI, so it is safely re-runnable and self-contained (never depends on
 * specific pre-seeded rows).
 *
 * Role used throughout: `admin`. Confirmed via `src/lib/permissions.ts`:
 * `CRM_MANAGE_ROLES` (create company/contract) = sales, finance, admin;
 * `TICKET_MANAGE_ROLES` (create ticket) = technician, dispatcher, admin;
 * `REPORT_VIEW_ALL_ROLES` (/reports/sla) = dispatcher, finance, admin.
 * `admin` is the only role in the intersection of all three, so a single
 * login covers the full workflow -- `dispatcher` (suggested by the plan for
 * ticket creation) is NOT in `CRM_MANAGE_ROLES` and cannot create the
 * SLA-bearing contract this spec depends on.
 */

test("SLA-bearing ticket shows a real SLA badge and is reflected on the SLA compliance report", async ({
  page,
}) => {
  await loginAs(page, "admin");

  // ---- Create a Company (CRM) ------------------------------------------
  const uniqueSuffix = Date.now();
  const companyName = `SLA Test Co ${uniqueSuffix}`;

  await page.goto("/clients/new");
  await page.locator("#name").fill(companyName);
  await page.getByRole("button", { name: "Create company" }).click();

  // createCompany redirects server-side to /clients/{id} on success.
  await page.waitForURL(/\/clients\/[^/]+$/);
  const companyUrl = page.url();

  // ---- Create an SLA-bearing Contract under that company ----------------
  // Contracts tab is not the default tab (Sites is) -- switch to it.
  await page.getByRole("tab", { name: "Contracts" }).click();

  // Billing type defaults to "block_hour" (ContractForm's initial state),
  // which requires a "Block hours" field -- fill it plus the required
  // startDate and both SLA target fields so the created ticket resolves a
  // contract with non-null slaResponseMinutes/slaResolutionMinutes.
  await page.locator("#blockHours").fill("10");

  const today = new Date().toISOString().slice(0, 10);
  await page.locator("#startDate").fill(today);

  await page.locator("#slaResponseMinutes").fill("60");
  await page.locator("#slaResolutionMinutes").fill("480");

  await page.getByRole("button", { name: "Add contract" }).click();

  // createContract does not redirect (returns { success: true } and
  // revalidates the current path) -- the ContractsTab's server-rendered
  // table re-renders in place. Wait for the new contract's SLA Response
  // cell to appear as the deterministic signal that the write landed and
  // the tab re-rendered with real data (rather than an arbitrary timeout).
  await expect(page.getByRole("cell", { name: "60 min" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "480 min" })).toBeVisible();

  // ---- Create a Ticket against that company ------------------------------
  // createTicket has no explicit contractId field in the form -- it always
  // resolves the company's active contract server-side
  // (resolveActiveContract: most recent non-expired contract by
  // startDate desc, id desc), which is exactly the contract just created
  // above (the company's only contract).
  const ticketSubject = `SLA badge check ${uniqueSuffix}`;

  await page.goto("/tickets/new");
  await page.locator("#companyId").click();
  await page.getByRole("option", { name: companyName }).click();

  await page.locator("#subject").fill(ticketSubject);
  await page.locator("#description").fill("Created by e2e/sla-tracking.spec.ts");

  await page.getByRole("button", { name: "Create ticket" }).click();

  // createTicket redirects server-side to /tickets/{id} on success.
  await page.waitForURL(/\/tickets\/[^/]+$/);

  // ---- Assert a real, non-"No SLA" SlaBadge renders on the detail page --
  // A brand-new ticket has firstRespondedAt/resolvedAt both null and both
  // SLA deadlines in the future (60/480 minutes out), so getSlaStatus
  // deterministically returns "on_track" -> SlaBadge renders the text
  // "On track" (src/components/tickets/sla-badge.tsx's STATUS_LABEL map).
  await expect(page.getByText(ticketSubject)).toBeVisible();
  const slaBadge = page.getByText("On track", { exact: true });
  await expect(slaBadge).toBeVisible();
  await expect(page.getByText("No SLA", { exact: true })).not.toBeVisible();

  // ---- SLA compliance report renders and reflects the new company -------
  // getSlaCompliance's Met/Breached counters only include tickets with an
  // unambiguous final outcome for a leg (met, or breached because the
  // deadline has already passed) -- a ticket created moments ago with
  // deadlines hours in the future contributes to neither counter yet (see
  // src/lib/reporting.ts's "excluded from both" comment), so this spec does
  // not assert on those counts. Instead it asserts the deterministic,
  // available signal: the company/contract filter (fed by a live
  // `db.company.findMany()` query in the page) lists the just-created
  // company, proving the report page's real data (not a placeholder) flows
  // through end to end.
  await page.goto("/reports/sla");
  await expect(page.getByRole("heading", { name: "SLA Compliance" })).toBeVisible();

  await page.locator("#companyId").click();
  await expect(page.getByRole("option", { name: companyName })).toBeVisible();
  await page.getByRole("option", { name: companyName }).click();

  await page.waitForURL((url) => url.searchParams.get("companyId") !== null);

  // With the company filter applied, the contract filter (scoped to that
  // company) should show the SLA-bearing contract just created --
  // confirming the report page's underlying query reflects this spec's
  // real, freshly-written data rather than stale or placeholder content.
  await expect(page.getByText(/Block Hours \(started/)).toBeVisible();

  // Response/Resolution summary cards render without error either way
  // (real data either as counts or an explicit "No data in this range"
  // state -- both are valid, deterministic outcomes; a thrown/500 page is
  // the only failure mode this assertion rules out).
  await expect(page.getByRole("heading", { name: "Response" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Resolution" })).toBeVisible();
});
