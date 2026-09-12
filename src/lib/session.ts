import { resolveActiveLegalEntityContext } from "@/lib/accounting/legal-entity";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import type {
  ProfileRole,
  SessionContext,
  TellerOrganization,
  TellerProfile,
  TellerSettings,
} from "@/types";

export async function getSessionContext(): Promise<SessionContext | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  let profile: TellerProfile | null = null;
  const profileWithActive = await supabase
    .from("teller_profiles")
    .select("id, organization_id, email, full_name, role, active_legal_entity_id")
    .eq("id", user.id)
    .maybeSingle();

  if (
    profileWithActive.error &&
    /active_legal_entity_id|schema cache|does not exist/i.test(profileWithActive.error.message)
  ) {
    const fallback = await supabase
      .from("teller_profiles")
      .select("id, organization_id, email, full_name, role")
      .eq("id", user.id)
      .maybeSingle();
    profile = (fallback.data as TellerProfile) ?? null;
  } else {
    profile = (profileWithActive.data as TellerProfile) ?? null;
  }

  let organization: TellerOrganization | null = null;
  let settings: TellerSettings | null = null;

  if (profile?.organization_id) {
    const [{ data: org }, { data: industry }] = await Promise.all([
      supabase
        .from("teller_organizations")
        .select(
          "id, name, legal_name, industry_id, partner_id, organization_source, phone, timezone, currency, address_line1, address_line2, city, state, postal_code, country, setup_completed_at",
        )
        .eq("id", profile.organization_id)
        .maybeSingle(),
      supabase
        .from("teller_industry_settings")
        .select("organization_id, answers, modules, labels")
        .eq("organization_id", profile.organization_id)
        .maybeSingle(),
    ]);
    organization = (org as TellerOrganization) ?? null;
    settings = (industry as TellerSettings) ?? null;
  }

  let activeLegalEntity = null;
  let accessibleLegalEntities: SessionContext["accessibleLegalEntities"];
  let showEntitySwitcher = false;

  if (profile?.organization_id && profile.role) {
    try {
      const activeContext = await resolveActiveLegalEntityContext(supabase, {
        organizationId: profile.organization_id,
        auth: { userId: user.id, role: profile.role as ProfileRole },
        persistedLegalEntityId: profile.active_legal_entity_id,
      });
      activeLegalEntity = {
        id: activeContext.legalEntity.id,
        name: activeContext.legalEntity.name,
        entityCode: activeContext.legalEntity.entityCode,
        isDefault: activeContext.legalEntity.isDefault,
      };
      accessibleLegalEntities = activeContext.accessibleEntities.map((entity) => ({
        id: entity.id,
        name: entity.name,
        entityCode: entity.entityCode,
        isDefault: entity.isDefault,
      }));
      showEntitySwitcher = activeContext.showEntitySwitcher;
    } catch {
      activeLegalEntity = null;
      accessibleLegalEntities = [];
      showEntitySwitcher = false;
    }
  }

  return {
    userId: user.id,
    email: user.email || profile?.email || "",
    profile: (profile as TellerProfile) ?? null,
    organization,
    settings,
    activeLegalEntity,
    accessibleLegalEntities,
    showEntitySwitcher,
  };
}

export function hasModule(
  settings: TellerSettings | null | undefined,
  moduleId: string,
): boolean {
  return Boolean(settings?.modules?.includes(moduleId));
}

/** Hassle Free AC integration module (accepts legacy "quoter" module id). */
export function hasHfacIntegration(
  settings: TellerSettings | null | undefined,
): boolean {
  return hasModule(settings, "hfac") || hasModule(settings, "quoter");
}

export function label(
  settings: TellerSettings | null | undefined,
  key: string,
  fallback: string,
): string {
  return settings?.labels?.[key] || fallback;
}
