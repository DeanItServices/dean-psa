"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * Route-group-level error boundary (Next.js `error.tsx` convention). Must be
 * a Client Component -- the framework rejects it otherwise. Covers all 13
 * routes nested under (dashboard) with this single file.
 *
 * Deliberately does not render `error.message`/`error.stack` -- those can
 * carry internal details (query text, file paths, etc.) that shouldn't be
 * shown to a non-admin user in production. The actual error is only logged
 * via console.error for observability; the UI shows a generic, safe message
 * plus (when present) the Next.js-assigned `digest` as a support reference.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-24 text-center">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Something went wrong</h2>
        <p className="text-sm text-muted-foreground">
          An unexpected error occurred while loading this page. Please try again.
        </p>
        {error.digest ? (
          <p className="text-xs text-muted-foreground">Reference: {error.digest}</p>
        ) : null}
      </div>
      <Button variant="outline" onClick={() => reset()}>
        Try again
      </Button>
    </div>
  );
}
