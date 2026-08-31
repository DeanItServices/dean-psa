import { requireRole } from "@/lib/session";
import { CRM_MANAGE_ROLES } from "@/lib/permissions";
import { CompanyForm } from "@/components/crm/company-form";

/**
 * Create-company page (/clients/new). Gated by requireRole(CRM_MANAGE_ROLES)
 * -- a technician or dispatcher navigating here directly by URL is
 * redirected to /unauthorized server-side, not merely hidden in the nav UI.
 */
export default async function NewClientPage() {
  await requireRole(CRM_MANAGE_ROLES);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Add Company</h1>
      <CompanyForm />
    </div>
  );
}
