/**
 * Pure timer duration/elapsed-time helpers. No database access, no
 * "use server", no side effects -- shared identically by the ticket
 * detail page's live-running-timer display (Plan 04-03, client-side) and
 * the `stopTimer` Server Action's final `durationMinutes` computation
 * (Plan 04-03, server-side). Must not depend on any browser-only or
 * Node-only API so it works correctly in both environments.
 */

/**
 * Computes whole minutes elapsed between `startedAt` and either `endedAt`
 * (if the timer has stopped) or `now` (defaulting to the current time,
 * for a still-running timer). Rounds down and never returns a negative
 * value -- a clock-skew case where `endedAt`/`now` is somehow before
 * `startedAt` clamps to 0 rather than going negative.
 */
export function computeElapsedMinutes(startedAt: Date, endedAt: Date | null, now?: Date): number {
  const end = endedAt ?? now ?? new Date();
  const elapsedMs = end.getTime() - startedAt.getTime();

  if (elapsedMs <= 0) {
    return 0;
  }

  return Math.floor(elapsedMs / (60 * 1000));
}

/**
 * Formats a minute count as a human-readable "Xh Ym" string, e.g.
 * 125 -> "2h 5m", 45 -> "0h 45m", 0 -> "0h 0m". Never throws on 0 or on
 * very large values.
 */
export function formatDuration(minutes: number): string {
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 0;
  const hours = Math.floor(safeMinutes / 60);
  const remainingMinutes = safeMinutes % 60;

  return `${hours}h ${remainingMinutes}m`;
}
