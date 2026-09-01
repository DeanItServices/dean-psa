"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { startTimer, stopTimer } from "@/lib/actions/time-entries";
import { computeElapsedMinutes, formatDuration } from "@/lib/timer";
import { isNextRedirectError } from "@/lib/is-next-redirect-error";

/** Re-render interval for the live elapsed-time display, in milliseconds.
 * Ticks every 30s rather than every second -- this is a coarse "Xh Ym"
 * display (see formatDuration), not a stopwatch, so second-level updates
 * would be wasted re-renders. */
const TICK_INTERVAL_MS = 30_000;

/**
 * Timer start/stop control for the ticket detail page. Follows
 * ticket-comment-form.tsx's Server Action + isNextRedirectError + pending
 * state pattern. When no timer is running (runningEntry is null), renders a
 * "Start Timer" button. When a timer is running, renders a live elapsed
 * time display (re-rendered on TICK_INTERVAL_MS via a forced re-render
 * tick, not a per-second interval) plus a "Stop Timer" button. The button
 * is disabled during the pending Server Action call to prevent
 * double-submission (double-start would be caught server-side anyway by
 * the running-timer check/P2002 backstop, but disabling avoids the
 * redundant request and flash of a needless error).
 */
export function TimerControl({
  ticketId,
  runningEntry,
}: {
  ticketId: string;
  runningEntry: { id: string; startedAt: Date } | null;
}) {
  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  // Forces a re-render every TICK_INTERVAL_MS so the elapsed-time display
  // advances while a timer is running. The tick value itself is unused --
  // only the state update (and resulting re-render) matters.
  const [, setTick] = React.useState(0);

  React.useEffect(() => {
    if (!runningEntry) {
      return;
    }

    const interval = setInterval(() => {
      setTick((value) => value + 1);
    }, TICK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [runningEntry]);

  function handleStart() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await startTimer(ticketId);
        if (result?.error) {
          setError(result.error);
        }
      } catch (err) {
        if (isNextRedirectError(err)) {
          throw err;
        }
        setError("Something went wrong. Please try again.");
      }
    });
  }

  function handleStop() {
    if (!runningEntry) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const result = await stopTimer(runningEntry.id);
        if (result?.error) {
          setError(result.error);
        }
      } catch (err) {
        if (isNextRedirectError(err)) {
          throw err;
        }
        setError("Something went wrong. Please try again.");
      }
    });
  }

  const elapsedMinutes = runningEntry
    ? computeElapsedMinutes(runningEntry.startedAt, null)
    : 0;

  return (
    <div className="flex flex-col gap-2">
      {runningEntry ? (
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">
            Timer running: {formatDuration(elapsedMinutes)}
          </span>
          <Button type="button" variant="outline" disabled={isPending} onClick={handleStop}>
            {isPending ? "Stopping..." : "Stop Timer"}
          </Button>
        </div>
      ) : (
        <Button type="button" disabled={isPending} onClick={handleStart}>
          {isPending ? "Starting..." : "Start Timer"}
        </Button>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
