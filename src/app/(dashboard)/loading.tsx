/**
 * Route-group-level loading UI (Next.js `loading.tsx` convention). Shown
 * automatically while any nested (dashboard) route's Server Component
 * data-fetch is in flight -- covers all 13 routes in the group with this
 * single file, no per-route duplicates needed.
 */
export default function DashboardLoading() {
  return (
    <div className="flex flex-1 items-center justify-center py-24">
      <div
        role="status"
        aria-live="polite"
        aria-label="Loading"
        className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
      >
        <span className="sr-only">Loading...</span>
      </div>
    </div>
  );
}
