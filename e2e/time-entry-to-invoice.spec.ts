import { test, expect } from "@playwright/test";
import { loginAs } from "./fixtures";

/**
 * E2E spec: time entry to invoice.
 *
 * Covers the "time entry to invoice" core workflow named in ROADMAP.md's
 * Phase 6 success criterion "Core workflows (ticket lifecycle, time entry
 * to invoice, SLA tracking) pass end-to-end verification":
 *
 * 1. As `finance` (has crm:manage + invoice:manage), create a brand-new
 *    Company and a single `hourly_breakfix` Contract on it with a known,
 *    fixed hourlyRate. hourly_breakfix is deliberately chosen over
 *    block_hour/flat_fee because its billing math
 *    (src/lib/billing.ts's computeHourlyBreakfixCharge) has no cumulative/
 *    lifetime-history dependency and no other-invoice interaction -- the
 *    expected invoice total is a pure function of this spec's own two
 *    known inputs (hourlyRate, minutes logged), so the assertion below is
 *    self-contained and deterministic without needing to know or control
 *    any pre-existing database state.
 * 2. As `technician` (has ticket:manage + timeentry:manage), create a new
 *    Ticket against that Company -- createTicket's server-side
 *    resolveActiveContract auto-resolves and snapshots the just-created
 *    Contract onto the new Ticket's contractId (confirmed by reading
 *    src/lib/actions/tickets.ts in full: since this is the Company's only
 *    Contract, it is unambiguously "the active contract" by the
 *    startDate DESC, id DESC rule). Then start the ticket's timer
 *    (TimerControl -- the only time-logging UI that exists; there is no
 *    manual time-entry-creation form anywhere in the app, confirmed by
 *    reading time-entry-list.tsx, timer-control.tsx and
 *    src/lib/actions/time-entries.ts in full) and stop it after a real
 *    elapsed wait just over 60 seconds.
 * 3. As `finance` again, generate an invoice for that Company covering a
 *    date range containing "now", and assert the invoice detail page's
 *    Total exactly matches hourlyRate * (loggedMinutes / 60), computed via
 *    the same formula as src/lib/billing.ts's computeHourlyBreakfixCharge
 *    (quantity = minutes/60, amount = quantity * hourlyRate). Also assert
 *    the ticket detail page now shows the time entry as "Invoiced".
 *
 * Decision: live timer vs. manual entry -- forced by there being no manual
 * time-entry-creation UI in the app at all (only TimerControl's
 * Start/Stop, per the source read above). stopTimer's durationMinutes is
 * computed server-side via src/lib/timer.ts's computeElapsedMinutes, which
 * floors real elapsed wall-clock milliseconds to whole minutes -- there is
 * no way to fabricate a non-zero duration without at least ~60 real
 * seconds elapsing between start and stop (Playwright's browser-side clock
 * mocking cannot affect a Server Action's server-side `new Date()` calls).
 * A ~65s real wait is used below (60s minimum + a small safety margin for
 * network/render latency between the start and stop clicks) to
 * deterministically land on exactly 1 billable minute -- short enough to
 * respect the plan's "no long sleeps" guidance while still being real
 * elapsed time, not a fabricated workaround.
 */

const HOURLY_RATE = 100;
const EXPECTED_MINUTES = 1;
const EXPECTED_TOTAL = (EXPECTED_MINUTES / 60) * HOURLY_RATE;
const TIMER_WAIT_MS = 65_000;

test.describe("time entry to invoice", () => {
  test("logging billable time against a ticket produces a correctly-computed invoice", async ({
    page,
  }) => {
    const uniqueSuffix = Date.now();
    const companyName = `E2E Billing Co ${uniqueSuffix}`;
    const ticketSubject = `E2E time-to-invoice ticket ${uniqueSuffix}`;

    // --- Step 1: finance creates the Company + hourly_breakfix Contract ---
    await loginAs(page, "finance");

    await page.goto("/clients/new");
    await page.locator("#name").fill(companyName);
    await page.getByRole("button", { name: "Create company" }).click();
    await page.waitForURL(/\/clients\/[^/]+$/);

    const companyUrl = page.url();
    const companyId = companyUrl.split("/clients/")[1];
    expect(companyId).toBeTruthy();

    await page.getByRole("tab", { name: "Contracts" }).click();

    await page.locator("#billingType").click();
    await page.getByRole("option", { name: "Hourly Break-Fix" }).click();
    await page.locator("#hourlyRate").fill(String(HOURLY_RATE));

    const today = new Date().toISOString().slice(0, 10);
    await page.locator("#startDate").fill(today);

    await page.getByRole("button", { name: "Add contract" }).click();
    await expect(page.getByText("Hourly Break-Fix")).toBeVisible();
    await expect(page.getByText(`$${HOURLY_RATE}/hr`)).toBeVisible();

    // --- Step 2: technician creates a Ticket against that Company, logs time ---
    await loginAs(page, "technician");

    await page.goto("/tickets/new");
    await page.locator("#companyId").click();
    await page.getByRole("option", { name: companyName }).click();
    await page.locator("#subject").fill(ticketSubject);
    await page
      .locator("#description")
      .fill("E2E spec: verifying time-entry-to-invoice billing math.");
    await page.getByRole("button", { name: "Create ticket" }).click();
    await page.waitForURL(/\/tickets\/[^/]+$/);

    const ticketUrl = page.url();

    await page.getByRole("button", { name: "Start Timer" }).click();
    await expect(page.getByText(/^Timer running:/)).toBeVisible();

    // Real elapsed wait -- see module doc above for why this cannot be
    // avoided or shortened below ~60s given the app's actual timer
    // implementation and the absence of any manual time-entry UI.
    await page.waitForTimeout(TIMER_WAIT_MS);

    await page.getByRole("button", { name: "Stop Timer" }).click();
    await expect(page.getByRole("button", { name: "Start Timer" })).toBeVisible();

    // The stopped entry's duration should now read "0h 1m" (formatDuration
    // of EXPECTED_MINUTES=1), confirming the server-computed duration
    // matches what this spec's assertion below expects.
    await expect(page.getByRole("cell", { name: "0h 1m" })).toBeVisible();

    // --- Step 3: finance generates the invoice and the total is verified ---
    await loginAs(page, "finance");

    await page.goto("/invoices");
    await page.locator("#companyId").click();
    await page.getByRole("option", { name: companyName }).click();
    await page.locator("#periodStart").fill(today);
    await page.locator("#periodEnd").fill(today);
    await page.getByRole("button", { name: "Generate Invoice" }).click();
    await page.waitForURL(/\/invoices\/[^/]+$/);

    const expectedTotalText = EXPECTED_TOTAL.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    });

    await expect(page.getByText("Hourly break-fix")).toBeVisible();
    await expect(
      page.getByText(`Total: ${expectedTotalText}`, { exact: true }),
    ).toBeVisible();

    // Confirm the time entry is now marked invoiced back on the ticket
    // detail page.
    await page.goto(ticketUrl);
    await expect(page.getByText("Invoiced")).toBeVisible();
  });
});
