import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { tellerBranding } from "@/lib/branding";
import { getIndustryPack } from "@/lib/industries/registry";
import { getPartner } from "@/lib/partners/registry";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";

export default async function BooksLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionContext();
  if (!session) redirect(routes.login);
  if (!session.organization) redirect(routes.setup);

  const pack = getIndustryPack(session.organization.industry_id);
  const partner = getPartner(session.organization.partner_id);
  const branding = tellerBranding(session.organization.partner_id);

  return (
    <AppShell
      companyName={session.organization.name}
      industryName={pack.name}
      partnerName={partner?.name ?? null}
      attached={branding.attached}
      modules={session.settings?.modules ?? []}
      labels={session.settings?.labels ?? {}}
    >
      {children}
    </AppShell>
  );
}
