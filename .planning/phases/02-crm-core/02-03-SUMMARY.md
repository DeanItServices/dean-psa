# Plan 02-03 Summary: Contacts CRUD (CRM Core Wave 3)

## Result
- **Status**: Complete
- **Wave**: 3
- **Agent**: Frontend Developer
- **Completed**: 2026-08-31

## Completed Tasks
1. **Task 1 -- Contact validation schema and Server Actions**: Wrote `src/lib/validations/contact.ts` exporting `contactSchema` exactly per the required interface (name required, email optional-or-empty-string with email format validation, phone/title/siteId optional strings). Wrote `src/lib/actions/contacts.ts` as a `"use server"` module exporting `createContact(companyId, formData)`, `updateContact(id, formData)`, `deleteContact(id)`, each starting with `await requireRole(CRM_MANAGE_ROLES)` (imported from `@/lib/permissions`), validating with `contactSchema.safeParse`, and using `db` from `@/lib/db`. `updateContact`/`deleteContact` catch Prisma's `P2025` (`Prisma.PrismaClientKnownRequestError` with `code === "P2025"`) and return `{ error: "Contact not found" }` instead of throwing; any other error re-throws.
2. **Task 2 -- Replace ContactsTab placeholder with real implementation**: Wrote `src/components/crm/contact-form.tsx` (`"use client"`) with name/email/phone/title inputs and a shadcn `Select` for the optional site association (using a `"none"` sentinel value, since Radix `SelectItem` disallows an empty-string value, mapped back to `undefined` before calling the Server Action). Replaced the body of `src/components/crm/contacts-tab.tsx`, preserving `export async function ContactsTab(props: CrmTabProps)` with `CrmTabProps` imported from `./tab-types` (unchanged import path/name), following `sites-tab.tsx`'s established async-Server-Component, self-fetching-via-`db` data pattern -- fetches the company's contacts (with `include: { site: true }`) and sites in parallel, renders a table of existing contacts plus `ContactForm` below it.

## Files Modified
- `src/lib/validations/contact.ts` (new) -- `contactSchema`.
- `src/lib/actions/contacts.ts` (new) -- `createContact`, `updateContact`, `deleteContact` Server Actions, each RBAC-gated via `CRM_MANAGE_ROLES`.
- `src/components/crm/contact-form.tsx` (new) -- add-contact client form with optional site select.
- `src/components/crm/contacts-tab.tsx` (modified in place, placeholder body replaced) -- real Contacts tab (list + add form).

No other files were read-write touched. Sibling plans 02-04 (Contracts) and 02-05 (Assets) were concurrently modifying `assets-tab.tsx`, `contracts-tab.tsx`, `app-sidebar.tsx`, and their own action/validation/form files in the same working tree, per `git status` at verification time -- none of those were touched by this plan.

## Verification Results (actual command outputs)

**Task 1:**
```
$ test -f src/lib/validations/contact.ts && echo "PASS: contact.ts exists"
PASS: contact.ts exists
$ test -f src/lib/actions/contacts.ts && echo "PASS: contacts.ts exists"
PASS: contacts.ts exists
$ grep -q 'requireRole' src/lib/actions/contacts.ts && echo "PASS: requireRole"
PASS: requireRole
$ grep -q 'CRM_MANAGE_ROLES' src/lib/actions/contacts.ts && echo "PASS: CRM_MANAGE_ROLES"
PASS: CRM_MANAGE_ROLES
$ grep -q 'createContact' src/lib/actions/contacts.ts && echo "PASS: createContact"
PASS: createContact
$ grep -q 'updateContact' src/lib/actions/contacts.ts && echo "PASS: updateContact"
PASS: updateContact
$ grep -q 'deleteContact' src/lib/actions/contacts.ts && echo "PASS: deleteContact"
PASS: deleteContact
```

**Task 2:**
```
$ grep -q 'export function ContactsTab' src/components/crm/contacts-tab.tsx
exit 1 (see Key Decisions #1 -- actual export is `export async function ContactsTab`)
$ grep -q 'CrmTabProps' src/components/crm/contacts-tab.tsx && echo "PASS: CrmTabProps"
PASS: CrmTabProps
$ grep -c 'Coming soon' src/components/crm/contacts-tab.tsx | xargs test 0 -eq && echo "PASS: no Coming soon"
PASS: no Coming soon
$ test -f src/components/crm/contact-form.tsx && echo "PASS: contact-form.tsx exists"
PASS: contact-form.tsx exists
$ grep -q 'createContact' src/components/crm/contact-form.tsx && echo "PASS: createContact used"
PASS: createContact used
$ npx tsc --noEmit
(no output, exit 0)
$ npm run build
✓ Compiled successfully in 13.8s
✓ Running TypeScript ... Finished TypeScript in 5.0s
✓ Generating static pages using 11 workers (8/8) in 1894ms
Route (app)
┌ ƒ /
├ ○ /_not-found
├ ƒ /api/auth/[...nextauth]
├ ƒ /clients
├ ƒ /clients/[companyId]
├ ƒ /clients/new
├ ○ /login
└ ƒ /unauthorized
(exit 0)
```

## Verification Commands Table

| Command | Exit Code | Result |
|---|---|---|
| `test -f src/lib/validations/contact.ts` | 0 | Pass |
| `test -f src/lib/actions/contacts.ts` | 0 | Pass |
| `grep -q 'requireRole' src/lib/actions/contacts.ts` | 0 | Pass |
| `grep -q 'CRM_MANAGE_ROLES' src/lib/actions/contacts.ts` | 0 | Pass |
| `grep -q 'createContact' src/lib/actions/contacts.ts` | 0 | Pass |
| `grep -q 'updateContact' src/lib/actions/contacts.ts` | 0 | Pass |
| `grep -q 'deleteContact' src/lib/actions/contacts.ts` | 0 | Pass |
| `grep -q 'export function ContactsTab' src/components/crm/contacts-tab.tsx` | 1 | Literal-string mismatch only -- see Key Decisions #1; actual export is `export async function ContactsTab`, an approved forward-compatible signature evolution per 02-02-SUMMARY.md precedent (`sites-tab.tsx` uses the identical pattern) |
| `grep -q 'CrmTabProps' src/components/crm/contacts-tab.tsx` | 0 | Pass |
| `grep -c 'Coming soon' src/components/crm/contacts-tab.tsx \| xargs test 0 -eq` | 0 | Pass -- zero occurrences |
| `test -f src/components/crm/contact-form.tsx` | 0 | Pass |
| `grep -q 'createContact' src/components/crm/contact-form.tsx` | 0 | Pass |
| `npx tsc --noEmit` | 0 | Pass -- zero errors project-wide |
| `npm run build` | 0 | Pass -- all routes including `/clients/[companyId]` compiled |
| `git status --porcelain` (manual check) | 0 | Pass -- only the 4 owned files touched by this plan; sibling plans' concurrent changes present but untouched by this plan |

## Key Decisions
1. **`ContactsTab` is `export async function ContactsTab(props: CrmTabProps)`, not `export function ContactsTab(props: CrmTabProps)`.** The plan's task-list verification line greps the literal string `'export function ContactsTab'`, which does not match an `async function` declaration (not a substring). However: (a) the plan's own "Required interfaces/content structure" section instructs following `sites-tab.tsx`'s established data-fetching pattern for consistency, and `sites-tab.tsx` itself is `export async function SitesTab(props: CrmTabProps)`; (b) 02-02-SUMMARY.md (the plan that created the placeholder and defines the Wave 3 handoff contract) explicitly documents this as an approved deviation: "replacing a sync stub with an `async` Server Component is explicitly permitted (forward-compatible signature evolution) -- see `sites-tab.tsx` ... for a working example of that exact pattern." The underlying contract -- same function name (`ContactsTab`), same single prop type (`CrmTabProps` imported from `./tab-types`, not re-declared), usable identically as `<ContactsTab companyId={...} />` by the parent page -- is fully preserved; `async` only changes how React/Next.js resolves the component internally, not its call-site signature. Followed the precedent rather than avoiding the pattern purely to satisfy a literal grep, consistent with the plan's own instruction to prioritize the sites-tab.tsx pattern for consistency. Flagged explicitly here rather than silently deviating.
2. **Data-fetching pattern**: followed `sites-tab.tsx` exactly -- `ContactsTab` is an async Server Component that self-fetches via `db.contact.findMany` and `db.site.findMany` (run in parallel via `Promise.all`) rather than receiving data as a prop, keeping `CrmTabProps` at exactly `{ companyId: string }` per the Wave 3 parallel-safety contract.
3. **Site select sentinel value**: Radix UI's `Select.Item` (used by shadcn's `SelectItem`) throws/disallows an empty string as `value`. Used the sentinel string `"none"` for the "No site" option in `contact-form.tsx`, translated back to omitting `siteId` from the submitted `FormData` (so the Server Action receives `undefined` and stores `null`). This satisfies the "company with zero sites" edge case: the dropdown always renders with at least the "No site" option and never crashes, since `sites` is simply an empty array mapped to zero additional `SelectItem`s.
4. **Empty-string coercion for optional fields**: `email`, `phone`, `title`, `siteId` are converted from empty string to `null` before the Prisma write (`email || null`, etc.) so clearing a field in an edit form (once wired up) stores `null` rather than `""`, matching the nullable `String?` columns in the Contact model.
5. **P2025 handling implemented with `Prisma.PrismaClientKnownRequestError`** (imported from `@prisma/client`) rather than a loose `err.code` check, for type safety; verified via `instanceof` before reading `.code`, with all other errors re-thrown rather than swallowed.
6. **Followed established form conventions** from `site-form.tsx`/`company-form.tsx`: `"use client"`, per-field `useState`, manually-built `FormData` passed directly to the Server Action (not `<form action={fn}>`), inline `role="alert"` error text with `text-destructive`.

## Issues Encountered
- The literal-string verification grep for `ContactsTab`'s export signature does not account for `async function` declarations, even though the plan's own reference pattern (`sites-tab.tsx`) and prior-plan precedent (02-02-SUMMARY.md) both use and endorse `async function` for exactly this kind of tab component. This is a wording gap in the verification script, not a functional defect -- `tsc --noEmit` and `npm run build` both confirm the component typechecks and compiles correctly as a drop-in replacement callable identically to the placeholder it replaced.

## Escalations
None. No stop-gate condition was hit: `contacts-tab.tsx` existed with the documented placeholder export; `prisma/schema.prisma`'s `Contact` model matched the expected shape (companyId, siteId nullable, name, email, phone, title) exactly; `sites-tab.tsx`'s data-fetching pattern was unambiguous (async Server Component, self-fetch via `db`), so no ambiguity-driven blocking judgment call was needed beyond following that documented pattern.

## Handoff Context
- `src/lib/actions/contacts.ts` exports `createContact(companyId, formData)`, `updateContact(id, formData)`, `deleteContact(id)`. Only `createContact` is currently wired to UI (via `ContactForm` in the Contacts tab); `updateContact` and `deleteContact` exist with correct RBAC gating, validation, and P2025 handling but have no UI entry point yet (no edit/delete affordance in the contacts table) -- consistent with the same gap 02-02 left for `updateCompany`/`deleteSite`. A later plan wanting inline edit/delete on the Contacts tab would extend `contacts-tab.tsx`/`contact-form.tsx`, which remain owned by this phase.
- `ContactsTab` is `export async function ContactsTab(props: CrmTabProps)` -- an async Server Component, matching `SitesTab`'s pattern. Any future plan referencing this component's exact export text should match on `ContactsTab` (name) + `CrmTabProps` (prop type), not on the literal substring `"export function"`.
- Site association uses a `"none"` sentinel in the UI layer only; the database and Server Action layer use `null`/`undefined` correctly -- no sentinel leaks past `contact-form.tsx`.

## Requirements Covered
- Contacts per client company (Phase 2 CRM entity) -- full create flow (with optional Site association) implemented and RBAC-gated; list view implemented; update/delete Server Actions implemented and RBAC-gated (UI wiring for edit/delete deferred, flagged above, matching the phase's established precedent for such gaps).
