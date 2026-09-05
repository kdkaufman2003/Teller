import { redirect } from "next/navigation";
import { PartnerPanel } from "@/components/PartnerPanel";
import { SettingsForm } from "@/components/SettingsForm";
import { getIndustryPack } from "@/lib/industries/registry";
import { getSessionContext } from "@/lib/session";
import { routes } from "@/lib/routes";
import type { OrganizationSource, TellerOrganization } from "@/types";

function defaultOrganization(org: TellerOrganization): TellerOrganization {
  return {
    ...org,
    organization_source: (org.organization_source ?? "direct") as OrganizationSource,
    phone: org.phone ?? "",
    timezone: org.timezone ?? "America/Chicago",
    currency: org.currency ?? "USD",
    address_line1: org.address_line1 ?? "",
    address_line2: org.address_line2 ?? "",
    city: org.city ?? "",
    state: org.state ?? "",
    postal_code: org.postal_code ?? "",
    country: org.country ?? "US",
  };
}

export default async function SettingsPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  const pack = getIndustryPack(session.organization.industry_id);
  const answers = session.settings?.answers ?? {};
  const organization = defaultOrganization(session.organization);

  return (
    <div className="space-y-6">
      <header className="page-header">
        <h1>Settings</h1>
        <p>Company profile and accounting configuration</p>
      </header>

      <PartnerPanel />

      <SettingsForm
        initialOrganization={organization}
        initialAnswers={answers}
        industryName={pack.name}
        modules={session.settings?.modules ?? []}
      />
    </div>
  );
}
