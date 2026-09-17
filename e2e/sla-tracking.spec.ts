import { expect } from "@playwright/test";
import { test, loginAs } from "./fixtures";

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
  await page.waitForURL(/\/clients\/(?!new$)[^/]+$/);

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
  await page.waitForURL(/\/tickets\/(?!new$)[^/]+$/);

  // ---- Assert a real, non-"No SLA" SlaBadge renders on the detail page --
  // A brand-new ticket has firstRespondedAt/resolvedAt both null and both
  // SLA deadlines in the future (60/480 minutes out), so getSlaStatus
  // deterministically returns "on_track" -> SlaBadge renders the text
  // "On track" (src/components/tickets/sla-badge.tsx's STATUS_LABEL map).
  // getByRole("heading"), NOT getByText: Next renders a permanent
  // `<div role="alert" id="__next-route-announcer__">` carrying the new
  // page's title, so getByText(ticketSubject) matched the <h1> AND that
  // announcer and died on a strict-mode violation. The announcer is a
  // `div`, so an explicit heading role can only resolve to the <h1>.
  // Same pattern tickets.spec.ts already uses on this page.
  await expect(page.getByRole("heading", { level: 1, name: ticketSubject })).toBeVisible();
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
  //
  // The contract Select must be OPENED to assert this. CompanyContractFilter
  // renders the contract labels as Radix SelectItems inside SelectContent,
  // which Radix mounts only while the select is open; with no contractId in
  // the URL the closed trigger reads "All contracts" and the label is
  // nowhere in the DOM. The previous assertion looked for the label on the
  // closed page and failed with "element(s) not found" -- it had never run
  // before this cycle, because the spec died four assertions earlier on the
  // route-announcer strict-mode violation above.
  await page.locator("#contractId").click();
  await expect(
    page.getByRole("option", { name: /^Block Hours \(started/ }),
  ).toBeVisible();

  // Close it again before asserting on anything else. Radix renders the open
  // SelectContent in a portal and marks the rest of the document inert, so
  // the two summary-card headings below are absent from the accessibility
  // tree -- and `getByRole` reads the accessibility tree -- while it is open.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("option", { name: /^Block Hours \(started/ })).toHaveCount(0);

  // Response/Resolution summary cards render without error either way
  // (real data either as counts or an explicit "No data in this range"
  // state -- both are valid, deterministic outcomes; a thrown/500 page is
  // the only failure mode this assertion rules out).
  //
  // Located by the card-title slot, NOT by getByRole("heading"): the summary
  // cards' titles are rendered by `CardTitle`, which is a plain `<div>`
  // unless the caller passes `asChild` with a real heading element, and
  // sla-compliance-summary.tsx does not. So these two strings carry no
  // heading role and `getByRole("heading", ...)` matched nothing -- an
  // assertion that could never have passed, which went unnoticed because the
  // spec had never reached this line. (That the report's two section titles
  // are not headings is a real accessibility gap, but it lives in `src/` and
  // is reported rather than papered over here.) The slot attribute scopes
  // each locator to exactly one element, so no `.first()` is needed.
  const cardTitles = page.locator('[data-slot="card-title"]');
  await expect(cardTitles.filter({ hasText: /^Response$/ })).toBeVisible();
  await expect(cardTitles.filter({ hasText: /^Resolution$/ })).toBeVisible();
});
