import type { SupabaseClient } from "@supabase/supabase-js";
import type { IndustryAnswers } from "@/lib/industries/types";
import { HFAC_INTEGRATION_MODULE } from "@/lib/integrations/constants";
import { getPartner } from "@/lib/partners/registry";
import type { PartnerId } from "@/lib/partners/types";

export function partnerIdFromAnswers(answers: Record<string, unknown>): PartnerId | null {
  const mode = String(answers.deploymentMode || "");
  if (mode === "attached") return "hasslefreeac";
  return null;
}

function wantsHfacIntegration(answers: IndustryAnswers): boolean {
  return Boolean(answers.connectHfac ?? answers.connectQuoter);
}

export function applyPartnerSetupDefaults(
  partnerId: PartnerId | null,
  answers: IndustryAnswers,
): IndustryAnswers {
  if (!partnerId) {
    return { ...answers, connectHfac: false, connectQuoter: false };
  }
  const partner = getPartner(partnerId);
  if (!partner) return answers;
  return {
    ...answers,
    connectHfac: true,
    connectQuoter: true,
    businessModel: answers.businessModel ?? "dealer",
    customerNoun: answers.customerNoun ?? "dealers",
    trackJobs: answers.trackJobs ?? true,
  };
}

export function ensureHfacModule(modules: string[], partnerId: PartnerId | null): string[] {
  const next = [...modules];
  const wants =
    partnerId === "hasslefreeac" ||
    next.includes(HFAC_INTEGRATION_MODULE) ||
    next.includes("quoter");
  if (wants && !next.includes(HFAC_INTEGRATION_MODULE)) next.push(HFAC_INTEGRATION_MODULE);
  if (!wants) {
    return next.filter((module) => module !== HFAC_INTEGRATION_MODULE && module !== "quoter");
  }
  return next.filter((module) => module !== "quoter");
}

/** @deprecated use ensureHfacModule */
export const ensureQuoterModule = ensureHfacModule;

export async function attachPartner(
  supabase: SupabaseClient,
  organizationId: string,
  partnerId: PartnerId,
) {
  const { error: orgError } = await supabase
    .from("teller_organizations")
    .update({ partner_id: partnerId, updated_at: new Date().toISOString() })
    .eq("id", organizationId);
  if (orgError) throw new Error(orgError.message);

  await supabase.from("teller_integrations").upsert({
    organization_id: organizationId,
    provider: partnerId,
    enabled: true,
    config: { attached_at: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  });

  await supabase.from("teller_integrations").upsert({
    organization_id: organizationId,
    provider: "hfac",
    enabled: true,
    updated_at: new Date().toISOString(),
  });

  const { data: settings } = await supabase
    .from("teller_industry_settings")
    .select("modules, answers")
    .eq("organization_id", organizationId)
    .maybeSingle();

  const modules = ensureHfacModule(settings?.modules ?? [], partnerId);
  const answers = applyPartnerSetupDefaults(partnerId, settings?.answers ?? {});

  await supabase
    .from("teller_industry_settings")
    .update({
      modules,
      answers: {
        ...answers,
        connectHfac: true,
        connectQuoter: true,
        deploymentMode: "attached",
      },
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", organizationId);
}

export async function detachPartner(supabase: SupabaseClient, organizationId: string) {
  const { error: orgError } = await supabase
    .from("teller_organizations")
    .update({ partner_id: null, updated_at: new Date().toISOString() })
    .eq("id", organizationId);
  if (orgError) throw new Error(orgError.message);

  await supabase
    .from("teller_integrations")
    .update({ enabled: false, updated_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .in("provider", ["hasslefreeac", "hfac", "quoter"]);

  const { data: settings } = await supabase
    .from("teller_industry_settings")
    .select("modules, answers")
    .eq("organization_id", organizationId)
    .maybeSingle();

  const modules = (settings?.modules ?? []).filter(
    (module: string) => module !== HFAC_INTEGRATION_MODULE && module !== "quoter",
  );
  const answers = {
    ...(settings?.answers ?? {}),
    connectHfac: false,
    connectQuoter: false,
    deploymentMode: "standalone",
  };

  await supabase
    .from("teller_industry_settings")
    .update({ modules, answers, updated_at: new Date().toISOString() })
    .eq("organization_id", organizationId);
}

export { wantsHfacIntegration };
