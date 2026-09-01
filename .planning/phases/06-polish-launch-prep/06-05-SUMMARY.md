# 06-05 Summary: UI Consistency

**Status: Complete**

## Files changed
- `src/app/(dashboard)/loading.tsx` (new) — route-group-level loading UI, covers all 13 nested routes.
- `src/app/(dashboard)/error.tsx` (new) — route-group-level Client Component error boundary, covers all 13 nested routes.
- `src/components/tickets/kanban-board.tsx` (modified) — added scroll-snap responsive behavior to the board's outer scroll container.
- `src/components/tickets/sla-badge.tsx` (modified) — migrated `STATUS_CLASS` from hardcoded Tailwind colors to theme tokens.

No files outside these four were modified. `.next/types` was regenerated (`npx next typegen`) to fix an unrelated pre-existing `LayoutProps` type error in `src/app/layout.tsx` (a gitignored build artifact missing because no `next dev`/`next build` had run yet in this worktree; not part of this plan's diff).

## Verification

```
test -f 'src/app/(dashboard)/loading.tsx'                          -> pass
test -f 'src/app/(dashboard)/error.tsx'                             -> pass
grep -q '"use client"' 'src/app/(dashboard)/error.tsx'              -> pass
grep -q 'reset' 'src/app/(dashboard)/error.tsx'                     -> pass
grep -q 'md:\|sm:\|lg:' src/components/tickets/kanban-board.tsx     -> pass (lg:snap-none, sm:gap-4)
grep -q 'KeyboardSensor' src/components/tickets/kanban-board.tsx    -> pass (untouched)
grep -qv 'bg-green-600\|bg-yellow-500' src/components/tickets/sla-badge.tsx -> pass
grep -q 'STATUS_LABEL' src/components/tickets/sla-badge.tsx         -> pass (untouched)
npx tsc --noEmit                                                     -> exit 0
```

## Decisions

**loading.tsx / error.tsx placement**: Both placed directly at `src/app/(dashboard)/` per Next.js App Router convention, confirmed against `src/app/(dashboard)/layout.tsx`'s structure (async Server Component wrapping all nested routes). One pair covers all 13 routes — no per-route duplication.

`error.tsx` starts with `"use client"` (line 1, required by Next.js for error boundaries), accepts `{ error, reset }: { error: Error & { digest?: string }; reset: () => void }`, logs the real error via `console.error(error)` inside a `useEffect`, and renders only a generic "Something went wrong" message plus (when present) `error.digest` as a support reference code — never `error.message`/`error.stack`. A "Try again" button (shadcn `Button`, `variant="outline"`) calls `reset()`.

**Kanban responsive strategy chosen**: The board's outer container (`kanban-board.tsx` line 156) already had `overflow-x-auto` with fixed-width (`w-72`) columns from `kanban-column.tsx` — i.e., horizontal-scroll-with-visible-columns was already the de facto layout, just with no responsive-prefixed styling and no scroll-snap. Rather than a stacked-column rewrite (larger diff, and `kanban-column.tsx` is a read-only target for this plan), I added CSS scroll-snap to the existing scroll container: `snap-x snap-mandatory` + `[&>*]:snap-start` so narrow-viewport swipe/scroll gestures land cleanly on column boundaries instead of stopping at arbitrary partial-column scroll positions (the prior gap-free experience). `lg:snap-none` disables snapping at desktop widths (verifying `lg:`+ behavior is visually unchanged — same `gap-4` via `sm:gap-4`, same `overflow-x-auto`, same column widths, since `kanban-column.tsx` was not modified). Below `sm:`, gap tightens slightly (`gap-3` vs `gap-4`) to fit marginally more of the adjacent column in view. All drag-and-drop, `KeyboardSensor`, and the `isMutatingRef`/`pendingTicketsRef` race guard are untouched — only the single className string on the existing wrapper `div` changed.

**Theme tokens used for SlaBadge**: `src/app/globals.css` was read in full — this project's theme defines only the shadcn/ui default token set (`primary`, `secondary`, `accent`, `muted`, `destructive`, `border`, `input`, `ring`, `chart-1..5`, `sidebar-*`), with no custom `success`/`warning` semantic tokens. `chart-*` tokens were considered and rejected — they're unused anywhere else in the codebase (confirmed via grep) and are grayscale-ish oklch values intended for chart series, not status semantics; using them would have made statuses harder to distinguish, not easier. Per the plan's instruction to use the closest existing token rather than invent new ones, `STATUS_CLASS` now uses:
- `no_sla`: `text-muted-foreground` (unchanged)
- `on_track` / `met`: `bg-primary text-primary-foreground [a&]:hover:bg-primary/90` (previously `bg-green-600`) — these two already shared identical styling before this change and still do; no new distinction was introduced or removed
- `approaching`: `bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90` (previously `bg-yellow-500`)
- `breached`: unchanged (empty string)

This matches the same token vocabulary `src/components/ui/badge.tsx`'s own `badgeVariants` already use for `default`/`secondary`, so `SlaBadge` now follows the same theming convention as the rest of the badge system, and both `--primary`/`--secondary` (and their `-foreground` pairs) are redefined under `.dark` in `globals.css`, so the badge now adapts correctly in dark mode.

**`breached` STATUS_CLASS decision**: Confirmed intentional, no change made. `STATUS_VARIANT.breached = "destructive"`, and `src/components/ui/badge.tsx`'s `destructive` variant (`bg-destructive text-white ... dark:bg-destructive/60`) is already fully theme-token-based (`--destructive` is defined in both `:root` and `.dark` in `globals.css`). `breached`'s empty `STATUS_CLASS` was already correct before this plan — it needs no token migration, only `on_track`/`approaching`/`met` had hardcoded colors to replace.

**Visual distinguishability check**: `no_sla` (outline/muted, effectively a bordered gray badge), `on_track`/`met` (primary — intentionally identical to each other, as before), `approaching` (secondary — a lighter/muted fill, contrasting with primary), `breached` (destructive — red). Four visually distinct treatments across the five statuses, matching the pre-existing distinguishability (on_track and met were never visually distinct from each other, before or after this change).

## Deviations
- Regenerated `.next/types` (via `npx next typegen`) to resolve a pre-existing, out-of-scope TypeScript error (`Cannot find name 'LayoutProps'` in `src/app/layout.tsx`, a file not in this plan's `files_modified`) caused by that Next.js 16 App Router generated-type artifact not yet existing in this worktree. This is a gitignored build output, not a source-file change, and was necessary for `npx tsc --noEmit` to exit 0 as required by this plan's verification criteria.

## Issues
None. No stop-gate condition was hit: `globals.css` has a usable (if limited) semantic token set, and `kanban-column.tsx`'s structure was fully compatible with the chosen minimal-diff responsive strategy without requiring any change to that file.
