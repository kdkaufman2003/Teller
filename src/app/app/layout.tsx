import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { tellerBranding } from "@/lib/branding";
import { getIndustryPack } from "@/lib/industries/registry";
import { getPartner } from "@/lib/partners/registry";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import {
  PRESENTATION_MODE_COOKIE,
  resolvePresentationMode,
} from "@/lib/ux/presentation-mode";

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
  const cookieStore = await cookies();
  const presentationMode = resolvePresentationMode({
    role: session.profile?.role,
    cookieMode: cookieStore.get(PRESENTATION_MODE_COOKIE)?.value ?? null,
    orgDefault:
      (session.settings?.answers as { defaultPresentationMode?: "owner" | "accountant" })
        ?.defaultPresentationMode ?? null,
  });

  return (
    <AppShell
      companyName={session.organization.name}
      industryName={pack.name}
      partnerName={partner?.name ?? null}
      attached={branding.attached}
      modules={session.settings?.modules ?? []}
      labels={session.settings?.labels ?? {}}
      activeLegalEntity={session.activeLegalEntity}
      accessibleLegalEntities={session.accessibleLegalEntities}
      showEntitySwitcher={session.showEntitySwitcher}
      presentationMode={presentationMode}
    >
      {children}
    </AppShell>
  );
}
