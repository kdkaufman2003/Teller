import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import type {
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

  const { data: profile } = await supabase
    .from("teller_profiles")
    .select("id, organization_id, email, full_name, role")
    .eq("id", user.id)
    .maybeSingle();

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

  return {
    userId: user.id,
    email: user.email || profile?.email || "",
    profile: (profile as TellerProfile) ?? null,
    organization,
    settings,
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
