import { redirect } from "next/navigation";
import { notFound } from "next/navigation";
import { requireActiveUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { db } from "@/lib/db";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SitesTab } from "@/components/crm/sites-tab";
import { ContactsTab } from "@/components/crm/contacts-tab";
import { ContractsTab } from "@/components/crm/contracts-tab";
import { AssetsTab } from "@/components/crm/assets-tab";

/**
 * Company detail page (/clients/[companyId]) -- the shared tabbed shell
 * that Wave 3 plans (Contacts, Contracts, Assets) plug into. Owned
 * exclusively by this plan per 02-CONTEXT.md's "UI/routing decisions".
 *
 * params is a Promise in this Next.js version (App Router dynamic segment
 * convention, see node_modules/next/dist/docs/01-app -- Dynamic Route
 * Segments) -- must be awaited before use.
 */
export default async function CompanyDetailPage({
  params,
}: {
  params: Promise<{ companyId: string }>;
}) {
  const { companyId } = await params;

  // requireActiveUser(), not getCurrentUser(): a shared layout does not
  // re-render on a soft navigation, so the inactive / mustChangePassword gate
  // has to run in the leaf too. See src/lib/session.ts. It also subsumes the
  // !user -> /login redirect this page used to open-code.
  const user = await requireActiveUser();

  if (!can(user.role, "crm:view")) {
    redirect("/unauthorized");
  }

  const company = await db.company.findUnique({
    where: { id: companyId },
    include: { sites: true },
  });

  if (!company) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{company.name}</h1>

      <Tabs defaultValue="sites">
        <TabsList>
          <TabsTrigger value="sites">Sites</TabsTrigger>
          <TabsTrigger value="contacts">Contacts</TabsTrigger>
          <TabsTrigger value="contracts">Contracts</TabsTrigger>
          <TabsTrigger value="assets">Assets</TabsTrigger>
        </TabsList>
        <TabsContent value="sites">
          <SitesTab companyId={company.id} />
        </TabsContent>
        <TabsContent value="contacts">
          <ContactsTab companyId={company.id} />
        </TabsContent>
        <TabsContent value="contracts">
          <ContractsTab companyId={company.id} />
        </TabsContent>
        <TabsContent value="assets">
          <AssetsTab companyId={company.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
