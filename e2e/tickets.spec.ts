import { test, expect } from "@playwright/test";
import { loginAs, ROLE_CREDENTIALS } from "./fixtures";

/**
 * E2E spec: Ticket Lifecycle (Plan 06-06).
 *
 * Covers: ticket creation, a Kanban status transition, assignment to a
 * technician, and the ownership-scoped delete behavior added by Plan 06-02
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
 * CONFIRMED GAP -- no delete UI exists for tickets anywhere in the app.
 * `deleteTicket` (src/lib/actions/tickets.ts) is not imported or called by
 * any component or page in `src/components/**` or `src/app/**` (verified via
 * project-wide grep during this plan's execution -- the only reference
 * outside `tickets.ts` itself is in `.planning/` planning documents). Plan
 * 06-02 implemented and unit-scoped the ownership-scoped delete logic in the
 * Server Action, but wiring a delete affordance into the UI was never in any
 * plan's `files_modified` (06-06 is explicitly forbidden from touching
 * `src/components/**`/`src/app/**` to add one). Per this plan's edge-case
 * guidance ("verify this by reading the actual ticket detail page's
 * delete-button wiring before writing the assertion" / do not assert on UI
 * text/elements that don't exist), this spec does NOT fabricate a delete
 * button or drive the Server Action via an undocumented internal wire
 * protocol (bypassing the UI). The two ownership-scoped delete tests below
 * are written as `test.fixme` with this exact rationale, so the gap is
 * tracked by the test suite itself rather than silently omitted. See this
 * plan's SUMMARY.md for the full explanation and the two options for
 * resolving it in a follow-up plan (add a real delete button, or explicitly
 * accept `deleteTicket` as dead code).
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

  test.describe("Ownership-scoped delete (Plan 06-02)", () => {
    test.fixme(
      true,
      "No delete UI exists anywhere in the app for tickets -- deleteTicket " +
        "(src/lib/actions/tickets.ts) is not called from any component or " +
        "page (confirmed via project-wide grep of src/components/** and " +
        "src/app/**). This plan (06-06) is forbidden from adding UI under " +
        "those paths. Writing this test against a fabricated button or an " +
        "undocumented direct Server-Action wire call would violate the " +
        "'real, confirmed selectors' requirement. See 06-06-SUMMARY.md.",
    );
    test("a technician cannot delete a ticket assigned to someone else", async () => {
      // Intentionally left unimplemented -- see the fixme above and
      // 06-06-SUMMARY.md's Decisions/Deviations section.
    });

    test.fixme(
      true,
      "No delete UI exists anywhere in the app for tickets -- see the fixme " +
        "on the previous test in this describe block for the full rationale.",
    );
    test("a technician can delete a ticket assigned to them", async () => {
      // Intentionally left unimplemented -- see the fixme above and
      // 06-06-SUMMARY.md's Decisions/Deviations section.
    });
  });
});

// Referenced to keep ROLE_CREDENTIALS's type-level shape (all 5 roles) part
// of this spec's compiled surface, matching the fixture's documented usage
// pattern -- avoids an unused-import lint/tsc concern while not hardcoding
// credentials directly (loginAs is the only call site that needs them).
void ROLE_CREDENTIALS;
