import Link from "next/link";
import { redirect } from "next/navigation";
import { PartnerPanel } from "@/components/PartnerPanel";
import { SettingsForm } from "@/components/SettingsForm";
import { getIndustryPack } from "@/lib/industries/registry";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
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

      <section className="card p-4">
        <h2 className="font-medium">Tax accounting</h2>
        <p className="text-muted mb-3 text-sm">Sales tax setup, liability account, and registration readiness.</p>
        <Link href={routes.taxSettings} className="btn btn-secondary">
          Tax
        </Link>
      </section>
    </div>
  );
}
