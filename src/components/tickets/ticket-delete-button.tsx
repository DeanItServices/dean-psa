"use client";

import * as React from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { deleteTicket } from "@/lib/actions/tickets";
import { isNextRedirectError } from "@/lib/is-next-redirect-error";

/**
 * Destructive confirmation for deleting a ticket, calling deleteTicket
 * (src/lib/actions/tickets.ts) directly.
 *
 * FOLLOWS user-row-actions.tsx IN FULL, CATCH INCLUDED -- AlertDialog +
 * useTransition + inline { error }, its blocked-not-disabled treatment of the
 * trigger, its always-mounted live region, and the isNextRedirectError rethrow
 * it took in turn from company-form.tsx. The rethrow is load-bearing in both
 * files for the same reason: the actions they call REDIRECT rather than
 * return. Every action user-row-actions.tsx calls opens with
 * requireRole(ADMIN_MANAGE_ROLES) (src/lib/actions/users.ts), and requireRole
 * redirects; deleteTicket does the same and then ends in redirect("/tickets").
 * Next implements a redirect by throwing a control-flow signal, so a catch
 * that treated every throw as a failure would render "Something went wrong"
 * over a delete that had just succeeded. The two paths are asymmetric on
 * purpose:
 *
 *   refusal  -> the action RETURNS { error }, which lands in `error` below
 *   success  -> the action REDIRECTS, and this component renders nothing new;
 *               the router navigates to /tickets and unmounts it
 *
 * THIS COMPONENT CONTAINS NO AUTHORIZATION LOGIC. The page renders it only
 * for admins, which is a UX courtesy and defence in depth -- requireRole()
 * inside deleteTicket is the security boundary. That matters twice over here:
 * requireRole REDIRECTS to /unauthorized rather than returning, so a
 * non-admin who reached this action anyway would never see a message from it.
 * There is no "you are not allowed" state below because control never comes
 * back to render one. e2e/tickets.spec.ts asserts that redirect at the Server
 * Action boundary rather than asserting this button is absent -- hiding a
 * button proves the layout gate, not the gate that matters.
 *
 * BLOCKED, NOT `disabled`, AND THE DIALOG IS CONTROLLED. user-row-actions.tsx
 * gives the reason for the first half: `disabled` drops focus to <body> when
 * it lands on the control that had it, and takes that control out of the tab
 * order entirely. The second half is what actually stops a double invocation
 * where a dialog is involved -- `disabled` on AlertDialogAction would do
 * nothing, because Radix has already closed the dialog by the time it would
 * apply. So the trigger stays focusable, carries aria-disabled, and says
 * "Deleting..." while the round trip is in flight, and `open` is held here so
 * a blocked trigger cannot re-open the confirmation. handleDelete's early
 * return is the last line of that defence rather than the only one: on its
 * own it refused the second confirmation in complete silence, which is the
 * worst possible acknowledgement for a destructive action.
 *
 * The confirmation copy names the cascades THIS ticket actually has, and
 * nothing else. TicketComment.ticket and TimeEntry.ticket are each
 * onDelete: Cascade, so confirming destroys the ticket's comments and its
 * logged time along with it and an admin cannot weigh a delete they are not
 * told the reach of -- but the commonest deletable ticket is a fresh or
 * mistaken one with neither, and "its 0 comments and the 0 time entries
 * logged against it" describes reach that does not exist. An empty cascade is
 * dropped from the sentence instead; with no time logged at all, the invoiced
 * refusal cannot arise either, so that sentence goes too and "This cannot be
 * undone." stands alone.
 */
export function TicketDeleteButton({
  ticketId,
  ticketSubject,
  commentCount,
  timeEntryCount,
}: {
  ticketId: string;
  ticketSubject: string;
  commentCount: number;
  timeEntryCount: number;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();

  // Held here, not left to Radix, so the trigger can stay focusable and
  // pressable-looking while refusing to open. See the header.
  const [open, setOpen] = React.useState(false);

  const errorId = `delete-ticket-error-${ticketId}`;

  // Only the cascades that exist. Both are rendered as inline text inside
  // AlertDialogDescription, which Radix renders as a <p> -- no block element
  // may be nested in it.
  const cascades: string[] = [];
  if (commentCount > 0) {
    cascades.push(commentCount === 1 ? "its 1 comment" : `its ${commentCount} comments`);
  }
  if (timeEntryCount > 0) {
    cascades.push(
      timeEntryCount === 1
        ? "the 1 time entry logged against it"
        : `the ${timeEntryCount} time entries logged against it`
    );
  }

  function handleDelete() {
    if (isPending) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const result = await deleteTicket(ticketId);
        // `"error" in result` FOLLOWED BY a truthiness check, for the same
        // reason user-row-actions.tsx gives: depending on how the action's
        // returns infer, TypeScript either produces a real discriminated
        // union or normalizes every member to `error?: undefined`. This form
        // compiles and behaves correctly under both, so a change to the
        // action's return shape cannot silently turn this branch into dead
        // code. `result` is optional-chained because the success path never
        // produces a value at all.
        if (result && "error" in result && result.error) {
          setError(result.error);
        }
      } catch (err) {
        // THE ONE LINE THIS COMPONENT TURNS ON. deleteTicket's success path
        // is a redirect, i.e. a throw. Swallowing it here would both report a
        // successful delete as an error and strand the admin on a page whose
        // ticket no longer exists.
        if (isNextRedirectError(err)) {
          throw err;
        }
        setError("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <div className="flex flex-col items-start">
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (next && isPending) {
            return;
          }
          setOpen(next);
        }}
      >
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            variant="destructive"
            // Visual stand-in for :disabled, which no longer applies. Pointer
            // events stay on, so a click still lands on a control whose own
            // open handler refuses it.
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            aria-disabled={isPending || undefined}
            aria-describedby={errorId}
          >
            {isPending ? "Deleting..." : "Delete ticket"}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{ticketSubject}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone.
              {cascades.length > 0 &&
                ` Deleting this ticket also permanently deletes ${cascades.join(" and ")}.`}
              {timeEntryCount > 0 &&
                " If any of that time has already been invoiced, the delete is" +
                  " refused and the invoice is named below instead."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={handleDelete}
            >
              Delete ticket
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rendered here rather than inside AlertDialogContent because Radix
          closes the dialog when its Action is activated, so an error placed
          in there would be unmounted at the moment it had something to say.
          That is also why this paragraph is mounted UNCONDITIONALLY and empty
          rather than conditionally, for the reason user-row-actions.tsx
          records: a live region must already be in the accessibility tree
          before its content changes, or the change is treated as new content
          and not announced -- and the commit that would have inserted this
          node is the same one in which Radix closes the dialog, un-hides the
          page and restores focus to the trigger, which is exactly the flush
          that swallows it. Only the text changes, so aria-describedby above
          can name a node that always exists. The empty-state margin is
          conditional instead of a container gap, so nothing reserves space
          for a message that is not there. */}
      <p
        id={errorId}
        role="alert"
        className="max-w-prose text-sm text-destructive [&:not(:empty)]:mt-2"
      >
        {error}
      </p>
    </div>
  );
}
