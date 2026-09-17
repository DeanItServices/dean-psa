import { test, expect } from "@playwright/test";
import { loginAs, newIsolatedContext, ROLE_CREDENTIALS } from "./fixtures";
import { captureActionCall, invokeAction, type ActionCall } from "./actions";
import { confirmInAlertDialog, expectPathname } from "./admin-users";
import { disconnectPrisma, prisma } from "./db";

/**
 * E2E spec: Ticket Lifecycle (Plan 06-06).
 *
 * Covers: ticket creation, a Kanban status transition, assignment to a
 * technician, and the admin-only delete behaviour hardened by Plan 09-02
 * (`src/lib/actions/tickets.ts`'s `deleteTicket`).
 *
 * Real, confirmed selectors used below (read from source during this plan's
 * execution, not guessed):
 * - `src/components/crm/company-form.tsx`: company-name input `#name`,
 *   submit button "Create company". `createCompany` (src/lib/actions/companies.ts)
 *   redirects to `/clients/{id}` on success -- the created company's id is
 *   read back from the post-submit URL.
 * - `src/components/tickets/ticket-form.tsx`: Radix `Select` triggers with
 *   ids `#companyId`, `#subject` (plain `Input`), `#description` (`Textarea`),
 *   submit button text "Create ticket" (disabled until a company is chosen).
 *   `createTicket` (src/lib/actions/tickets.ts) redirects to
 *   `/tickets/{id}` on success.
 * - `src/app/(dashboard)/tickets/[ticketId]/page.tsx`: renders `ticket.subject`
 *   in an `<h1>`, the status as a `Badge` with text `ticket.status.replace(/_/g,
 *   " ")` (e.g. "in progress"), and -- only for ticket:assign roles
 *   (dispatcher/admin) -- an `AssignmentControl` Select with id `#assign`
 *   whose options render `user.name ?? user.email`.
 * - `src/components/tickets/kanban-board.tsx` + `kanban-column.tsx`: the
 *   ONLY status-change affordance in the entire app is Kanban drag-and-drop
 *   (`@dnd-kit/core`, `PointerSensor` + `KeyboardSensor`). The ticket detail
 *   page has no status select/button. Each column is a `useDroppable` region
 *   keyed by its `status` string; cards are `useSortable` and only carry
 *   drag listeners when `draggable` (ticket:manage) is true. There is no
 *   `data-testid` anywhere in these components, so the spec locates the
 *   destination column via its column header text (`KanbanColumn`'s
 *   `<h2>{label}</h2>`, e.g. "In Progress") and drives the transition with a
 *   manual `page.mouse` pointer sequence (hover, down, several incremental
 *   moves, up) rather than Playwright's single-jump `locator.dragTo()`.
 *   `kanban-board.tsx` configures `PointerSensor` with
 *   `activationConstraint: { distance: 4 }` and `closestCorners` collision
 *   detection (confirmed by reading the component source) -- `dragTo()`
 *   issues one mouse-move directly from source to target, which is a
 *   documented source of flakiness for dnd-kit boards because it may not
 *   generate enough intermediate pointermove events for the activation
 *   distance to trip and for closestCorners to resolve to the right
 *   droppable during the move. Stepping the pointer across several
 *   intermediate positions exercises `PointerSensor`'s real pointer-event
 *   listeners the way an actual drag does, rather than a synthetic
 *   Server Action call.
 *
 * ADMIN-ONLY DELETE (Phase 9). The delete gap this header used to describe is
 * closed: `src/components/tickets/ticket-delete-button.tsx` renders an
 * AlertDialog on the ticket detail page, inside an admin-only "Danger zone"
 * section, and it calls `deleteTicket` directly. The three cases at the bottom
 * of this file replace the two unimplemented placeholders that stood in for it
 * while no delete affordance existed.
 *
 * WHAT THOSE THREE CASES ASSERT, AND WHY THE MIDDLE ONE LOOKS DIFFERENT.
 * `deleteTicket` is gated by `requireRole(ADMIN_MANAGE_ROLES)`, and
 * `requireRole` calls `redirect("/unauthorized")` -- it does not return an
 * error. So there is no refusal message for a non-admin to see, and the
 * component never renders one. The non-admin case therefore asserts the
 * SERVER'S behaviour: it replays a real, captured `deleteTicket` invocation
 * with the technician's own cookies (e2e/actions.ts) and requires the
 * redirect. Asserting only that the button is hidden would pass with the role
 * check deleted -- Phase 7's review found exactly that defect in a different
 * spec. The hidden button is checked too, but it is labelled below as what it
 * is: defence in depth, not the discriminator.
 *
 * The success path is the mirror image: `deleteTicket` ends in
 * `redirect("/tickets")`, which Next implements by THROWING a control-flow
 * signal, so the admin case asserts a navigation rather than a return value.
 */

test.describe("Ticket lifecycle", () => {
  test("dispatcher creates a ticket and the detail page renders it correctly", async ({ page }) => {
    const uniqueSuffix = Date.now();
    const companyName = `E2E Ticket Co ${uniqueSuffix}`;
    const subject = `E2E ticket subject ${uniqueSuffix}`;
    const description = `E2E ticket description ${uniqueSuffix}`;

    // Setup: create a company via the real UI. Dispatcher lacks crm:manage
    // (CRM_MANAGE_ROLES = ["sales", "finance", "admin"], confirmed in
    // src/lib/permissions.ts), so an admin session creates the seed company
    // this test needs -- this keeps the spec self-sufficient without
    // depending on any pre-existing CRM data.
    await loginAs(page, "admin");
    await page.goto("/clients/new");
    await page.locator("#name").fill(companyName);
    await page.getByRole("button", { name: "Create company" }).click();
    await page.waitForURL(/\/clients\/[^/]+$/);
    const companyId = page.url().split("/clients/")[1];
    expect(companyId).toBeTruthy();

    // Act: create the ticket as dispatcher (in TICKET_MANAGE_ROLES).
    await loginAs(page, "dispatcher");
    await page.goto("/tickets/new");

    await page.locator("#companyId").click();
    await page.getByRole("option", { name: companyName }).click();
    await page.locator("#subject").fill(subject);
    await page.locator("#description").fill(description);
    await page.getByRole("button", { name: "Create ticket" }).click();

    // createTicket redirects to /tickets/{id} on success.
    await page.waitForURL(/\/tickets\/[^/]+$/);

    // Assert: detail page renders the submitted subject/description.
    await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
    await expect(page.getByText(description)).toBeVisible();
    // Newly-created tickets default to status "new" (ticket-form.tsx's
    // initial React state / createTicket's schema default).
    await expect(page.getByText("new", { exact: true })).toBeVisible();
  });

  test("a ticket moves between Kanban columns and the new status persists", async ({ page }) => {
    const uniqueSuffix = Date.now();
    const companyName = `E2E Kanban Co ${uniqueSuffix}`;
    const subject = `E2E kanban subject ${uniqueSuffix}`;

    await loginAs(page, "admin");
    await page.goto("/clients/new");
    await page.locator("#name").fill(companyName);
    await page.getByRole("button", { name: "Create company" }).click();
    await page.waitForURL(/\/clients\/[^/]+$/);

    await loginAs(page, "dispatcher");
    await page.goto("/tickets/new");
    await page.locator("#companyId").click();
    await page.getByRole("option", { name: companyName }).click();
    await page.locator("#subject").fill(subject);
    await page.locator("#description").fill("E2E kanban description");
    await page.getByRole("button", { name: "Create ticket" }).click();
    await page.waitForURL(/\/tickets\/[^/]+$/);
    const ticketId = page.url().split("/tickets/")[1];

    // Act: drag the new ticket's card from the "New" column to "In
    // Progress" on the Kanban board (/tickets). The card is located by its
    // subject text (ticket-card.tsx renders the subject as a Link), and the
    // destination is the "In Progress" column's droppable region
    // (kanban-column.tsx's outer div, located relative to its <h2> label).
    await page.goto("/tickets");
    const card = page.getByRole("link", { name: subject });
    await expect(card).toBeVisible();

    const destinationColumn = page
      .locator("div")
      .filter({ has: page.getByRole("heading", { level: 2, name: "In Progress" }) })
      .last();
    await expect(destinationColumn).toBeVisible();

    // Manual pointer sequence instead of locator.dragTo(): dragTo() issues a
    // single mouse-move jump straight from source to target, which is a
    // documented source of flakiness against dnd-kit boards -- it may not
    // generate enough intermediate pointermove events for PointerSensor's
    // `activationConstraint: { distance: 4 }` to activate the drag, or for
    // `closestCorners` collision detection to resolve to the destination
    // droppable mid-move (both confirmed in kanban-board.tsx). Stepping the
    // pointer across several intermediate positions mirrors a real drag.
    const sourceBox = await card.boundingBox();
    const destinationBox = await destinationColumn.boundingBox();
    if (!sourceBox || !destinationBox) {
      throw new Error("Could not resolve bounding box for drag source/destination");
    }

    const startX = sourceBox.x + sourceBox.width / 2;
    const startY = sourceBox.y + sourceBox.height / 2;
    const endX = destinationBox.x + destinationBox.width / 2;
    const endY = destinationBox.y + Math.min(40, destinationBox.height / 2);

    await card.hover();
    await page.mouse.move(startX, startY);
    await page.mouse.down();

    // Several incremental moves: the first must clear the 4px activation
    // distance, and the rest give closestCorners enough intermediate
    // pointer positions to track the drag into the destination column
    // before the final drop.
    const steps = 5;
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      await page.mouse.move(startX + (endX - startX) * t, startY + (endY - startY) * t);
    }

    await page.mouse.move(endX, endY);
    await page.mouse.up();

    // Assert: reload and confirm the status change persisted server-side
    // (updateTicketStatus writes to the DB and revalidates both /tickets
    // and /tickets/{id}).
    await page.goto(`/tickets/${ticketId}`);
    await expect(page.getByText("in progress", { exact: true })).toBeVisible();
  });

  test("dispatcher assigns a ticket to a technician and the assignment persists", async ({ page }) => {
    const uniqueSuffix = Date.now();
    const companyName = `E2E Assign Co ${uniqueSuffix}`;
    const subject = `E2E assign subject ${uniqueSuffix}`;

    await loginAs(page, "admin");
    await page.goto("/clients/new");
    await page.locator("#name").fill(companyName);
    await page.getByRole("button", { name: "Create company" }).click();
    await page.waitForURL(/\/clients\/[^/]+$/);

    await loginAs(page, "dispatcher");
    await page.goto("/tickets/new");
    await page.locator("#companyId").click();
    await page.getByRole("option", { name: companyName }).click();
    await page.locator("#subject").fill(subject);
    await page.locator("#description").fill("E2E assignment description");
    await page.getByRole("button", { name: "Create ticket" }).click();
    await page.waitForURL(/\/tickets\/[^/]+$/);
    const ticketId = page.url();

    // Act: dispatcher has ticket:assign, so the detail page renders the
    // AssignmentControl Select (#assign). Assign to the seeded technician
    // ("Technician Test User", per prisma/seed.ts's TEST_USERS name field --
    // AssignmentControl's SelectItem renders user.name ?? user.email).
    await page.locator("#assign").click();
    await page.getByRole("option", { name: "Technician Test User" }).click();

    // AssignmentControl calls assignTicket directly (no page navigation) --
    // wait for its own success signal (the error text NOT appearing) rather
    // than a URL change, then reload to confirm server-side persistence.
    await expect(page.getByRole("alert")).toHaveCount(0);

    await page.goto(ticketId);
    await expect(page.getByText("Technician Test User")).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Admin-only delete (Plan 09-03), against Plan 09-02's hardened action
  // -------------------------------------------------------------------------

  test("an admin deletes a ticket with no invoiced time and it disappears", async ({
    browser,
  }) => {
    const context = await newIsolatedContext(browser);
    const page = await context.newPage();
    const { companyId, ticketId } = await seedDeletableTicket("admin-delete");

    try {
      await loginAs(page, "admin");
      await page.goto(`/tickets/${ticketId}`);

      await page.getByRole("button", { name: "Delete ticket", exact: true }).click();
      await confirmInAlertDialog(page, "Delete ticket");

      // deleteTicket ends in redirect("/tickets"). Next implements that by
      // THROWING a control-flow signal, which the component deliberately
      // rethrows rather than rendering as a failure -- so the success
      // assertion is a NAVIGATION, and the absence of an error is asserted
      // alongside it. A component that caught the redirect would leave the
      // browser on the detail page showing "Something went wrong", and both
      // halves of this would fail.
      await expectPathname(page, "/tickets");
      await expect(page.locator('p[role="alert"]')).toHaveCount(0);

      expect(
        await prisma().ticket.count({ where: { id: ticketId } }),
        "the confirmed delete must have removed the ticket row",
      ).toBe(0);

      // The cascade is the reason the confirmation copy names it. TimeEntry
      // .ticket is onDelete: Cascade, so the uninvoiced entry goes too.
      expect(
        await prisma().timeEntry.count({ where: { ticketId } }),
        "the delete cascades to the ticket's time entries",
      ).toBe(0);
    } finally {
      await context.close();
      await dropCompany(companyId);
    }
  });

  test("a non-admin cannot delete a ticket -- the SERVER refuses, not a hidden button", async ({
    browser,
  }) => {
    test.setTimeout(90_000);

    // Two tickets. The throwaway is really deleted by a real admin, which is
    // the only way to learn this build's `deleteTicket` action id (it changes
    // every build, so nothing here is hardcoded -- see e2e/actions.ts). The
    // victim is what the technician's replayed call is then pointed at.
    const throwaway = await seedDeletableTicket("capture-source");
    const victim = await seedDeletableTicket("non-admin-victim");

    const adminContext = await newIsolatedContext(browser);
    const adminPage = await adminContext.newPage();
    const techContext = await newIsolatedContext(browser);
    const techPage = await techContext.newPage();

    try {
      await loginAs(adminPage, "admin");
      await adminPage.goto(`/tickets/${throwaway.ticketId}`);

      const call = await captureActionCall(adminPage, async () => {
        await adminPage
          .getByRole("button", { name: "Delete ticket", exact: true })
          .click();
        await confirmInAlertDialog(adminPage, "Delete ticket");
        await expectPathname(adminPage, "/tickets");
      });

      await loginAs(techPage, "technician");

      // DEFENCE IN DEPTH, NOT THE ASSERTION. The page hides the control for
      // a non-admin, which is a UX courtesy -- it is checked here so a
      // regression that started showing a button that can only ever be
      // refused is noticed, and it is NOT what this test rests on. Deleting
      // the role check from deleteTicket would leave this expectation green.
      await techPage.goto(`/tickets/${victim.ticketId}`);
      await expect(
        techPage.getByRole("button", { name: "Delete ticket", exact: true }),
      ).toHaveCount(0);

      // THE ASSERTION. A Server Action is addressed by an id and needs no
      // page to invoke, so not being shown a button is not the boundary.
      // This is the exact request the browser would have sent if the control
      // were there, carrying the technician's own cookies.
      const response = await invokeAction(
        techContext,
        `/tickets/${victim.ticketId}`,
        call,
        retargetTicketId(call, victim.ticketId),
      );

      expect(
        response.redirectedTo,
        "a technician invoking deleteTicket must be redirected to /unauthorized by " +
          "requireRole(), not served -- requireRole REDIRECTS, it does not return an error",
      ).toBe("/unauthorized");
      expect(
        response.result,
        "the action must not have returned a result to a technician",
      ).toBeNull();
      expect(
        await prisma().ticket.count({ where: { id: victim.ticketId } }),
        "the refused delete must not have removed the row",
      ).toBe(1);
    } finally {
      await adminContext.close();
      await techContext.close();
      await dropCompany(throwaway.companyId);
      await dropCompany(victim.companyId);
    }
  });

  test("a ticket whose time is invoiced cannot be deleted, and the error names the invoice", async ({
    browser,
  }) => {
    const context = await newIsolatedContext(browser);
    const page = await context.newPage();
    const seeded = await seedInvoicedTicket("invoiced-refusal");

    try {
      await loginAs(page, "admin");
      await page.goto(`/tickets/${seeded.ticketId}`);

      await page.getByRole("button", { name: "Delete ticket", exact: true }).click();
      await confirmInAlertDialog(page, "Delete ticket");

      // The refusal path RETURNS { error } rather than redirecting, so the
      // browser stays put and the component renders the action's own string.
      //
      // Scoped to the component's own `<p role="alert">`, NOT getByRole("alert"):
      // Next renders a permanent `<div role="alert" id="__next-route-announcer__">`
      // on every page, so the accessible-role locator matches two elements and
      // fails on strict mode. e2e/fixtures.ts's loginExpectingFailure carries
      // the same note for the same reason.
      await expect(page.locator('p[role="alert"]')).toHaveText(seeded.expectedRefusal);
      await expectPathname(page, `/tickets/${seeded.ticketId}`);

      expect(
        await prisma().ticket.count({ where: { id: seeded.ticketId } }),
        "the refused delete must not have removed the ticket",
      ).toBe(1);
      expect(
        await prisma().invoiceLineItem.count({ where: { id: seeded.lineItemId } }),
        "nor touched the invoice line item the refusal is protecting",
      ).toBe(1);
    } finally {
      await context.close();
      await dropCompany(seeded.companyId);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixtures for the three delete cases
// ---------------------------------------------------------------------------

/**
 * EVERY DELETE CASE BUILDS ITS OWN DATA, AND NONE OF IT IS SEED STATE.
 *
 * This file runs in the `advisory` project under `fullyParallel: true` against
 * the shared dev database, so another spec -- or another case in this one --
 * may be mutating seeded rows while these run. A delete case that leaned on
 * seeded tickets would either destroy something a concurrent spec was reading
 * or fail for a reason having nothing to do with `deleteTicket`.
 *
 * Each helper creates a company of its own and returns its id; the case drops
 * that company in its `finally`. `Ticket.company`, `Invoice.company` and
 * `Contract.company` are all `onDelete: Cascade`, so one delete takes the whole
 * fixture with it -- including the rows a REFUSED case deliberately left
 * behind. Nothing here touches the five seeded fixture accounts, which
 * e2e/global-teardown.ts diffs at the end of every run.
 *
 * Rows are created through Prisma rather than through the UI because these
 * cases are about `deleteTicket`, not about the create forms three cases above
 * already drive -- and because there is no UI at all for attaching a time entry
 * to an invoice line item, which is the whole premise of the third case.
 */
const DELETE_FIXTURE_RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let fixtureSeq = 0;

function fixtureName(label: string): string {
  fixtureSeq += 1;
  return `E2E Delete ${label} ${DELETE_FIXTURE_RUN}-${fixtureSeq}`;
}

async function seedDeletableTicket(
  label: string,
): Promise<{ companyId: string; ticketId: string }> {
  const name = fixtureName(label);
  const company = await prisma().company.create({ data: { name } });
  const ticket = await prisma().ticket.create({
    data: {
      companyId: company.id,
      subject: name,
      description: `Fixture for the ${label} delete case.`,
      // An UNinvoiced entry, so the cascade has something real to remove and
      // the admin case can assert it went. invoiceLineItemId stays null --
      // that is what makes this ticket deletable.
      timeEntries: {
        create: {
          startedAt: new Date("2026-08-10T09:00:00Z"),
          endedAt: new Date("2026-08-10T10:00:00Z"),
          durationMinutes: 60,
          isBillable: true,
          notes: "Uninvoiced fixture time.",
        },
      },
    },
  });

  return { companyId: company.id, ticketId: ticket.id };
}

/**
 * The invoice-period formatter, mirroring `invoicePeriodFormatter` in
 * src/lib/actions/tickets.ts.
 *
 * 09-02 made that formatter an explicit `Intl.DateTimeFormat("en-US", {
 * dateStyle: "medium" })` at module scope precisely so the refusal string does
 * not depend on the server's locale. Constructing the same formatter here
 * rather than hardcoding "Aug 1, 2026" keeps this assertion a statement about
 * the MESSAGE TEMPLATE, which is what this case is for, instead of a statement
 * about the machine's locale database.
 *
 * The period instants are at midday UTC for the same reason: a date pinned to
 * midnight renders as the previous day in any timezone west of UTC, which
 * would make the fixture read as "Jul 31" on one machine and "Aug 1" on
 * another for no reason connected to the code under test.
 */
const invoicePeriodFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

async function seedInvoicedTicket(label: string): Promise<{
  companyId: string;
  ticketId: string;
  lineItemId: string;
  expectedRefusal: string;
}> {
  const name = fixtureName(label);
  const periodStart = new Date("2026-08-01T12:00:00Z");
  const periodEnd = new Date("2026-08-31T12:00:00Z");
  const status = "finalized";

  const company = await prisma().company.create({ data: { name } });
  const invoice = await prisma().invoice.create({
    data: {
      companyId: company.id,
      periodStart,
      periodEnd,
      status,
      subtotal: "150.00",
      total: "150.00",
      lineItems: {
        create: {
          description: `Billable time -- ${name}`,
          quantity: "1.00",
          unitRate: "150.00",
          amount: "150.00",
        },
      },
    },
    include: { lineItems: true },
  });
  const lineItem = invoice.lineItems[0]!;

  const ticket = await prisma().ticket.create({
    data: {
      companyId: company.id,
      subject: name,
      description: `Fixture for the ${label} delete case.`,
      timeEntries: {
        create: {
          startedAt: new Date("2026-08-12T09:00:00Z"),
          endedAt: new Date("2026-08-12T10:00:00Z"),
          durationMinutes: 60,
          isBillable: true,
          notes: "Already invoiced.",
          invoiceLineItemId: lineItem.id,
        },
      },
    },
  });

  // The template below is transcribed from the `return { error: ... }` in
  // deleteTicket (src/lib/actions/tickets.ts) -- possessive "'s", an ASCII
  // hyphen with spaces around it because medium dates contain commas, and the
  // invoice named by company + period + status because `model Invoice` has no
  // invoice-number field to name it by.
  const expectedRefusal =
    `Cannot delete: time on this ticket is billed to ${name}'s invoice ` +
    `for ${invoicePeriodFormatter.format(periodStart)} - ` +
    `${invoicePeriodFormatter.format(periodEnd)} (${status}). ` +
    "Void or adjust that invoice first.";

  return { companyId: company.id, ticketId: ticket.id, lineItemId: lineItem.id, expectedRefusal };
}

/** Drops a fixture company, and with it every row that cascades from it. */
async function dropCompany(companyId: string): Promise<void> {
  await prisma().company.deleteMany({ where: { id: companyId } });
}

/**
 * Re-points a captured `deleteTicket(id)` call at a different ticket.
 *
 * The shape check is the point, exactly as `retargetUserId` in e2e/actions.ts
 * explains for the user actions: a substitution that silently failed would
 * replay the ORIGINAL target -- a ticket the admin has already deleted -- and
 * the non-admin case would then pass on a P2025, proving nothing about the
 * role gate.
 */
function retargetTicketId(call: ActionCall, ticketId: string): string {
  expect(
    call.body,
    'expected deleteTicket\'s single-string-argument body, of the form ["<ticketId>"]',
  ).toMatch(/^\["[^"]+"\]$/);

  return JSON.stringify([ticketId]);
}

// Referenced to keep ROLE_CREDENTIALS's type-level shape (all 5 roles) part
// of this spec's compiled surface, matching the fixture's documented usage
// pattern -- avoids an unused-import lint/tsc concern while not hardcoding
// credentials directly (loginAs is the only call site that needs them).
void ROLE_CREDENTIALS;

// The runner process opens its own Prisma client for the fixture helpers
// above. Closing it keeps this spec from holding a connection open past the
// last case, the way e2e/user-lifecycle.spec.ts does for the same client.
test.afterAll(async () => {
  await disconnectPrisma();
});
