import type { SupabaseClient } from "@supabase/supabase-js";
import { recordTaxAuditEvent } from "../audit";
import type { TaxFilingFrequency } from "../types";
import { getStateTaxPack } from "./registry";
import type { StateTaxPack } from "./types";

export type ActivateStateTaxPackInput = {
  organizationId: string;
  packId: string;
  registrationNumber?: string | null;
  filingFrequency?: TaxFilingFrequency;
  effectiveFrom: string;
  actorId?: string | null;
};

export type ActivateStateTaxPackResult = {
  registrationId: string;
  packId: string;
  packVersion: string;
  rulesMaterialized: number;
  alreadyActive: boolean;
};

export async function activateStateTaxPack(
  supabase: SupabaseClient,
  input: ActivateStateTaxPackInput,
): Promise<ActivateStateTaxPackResult> {
  const pack = getStateTaxPack(input.packId);
  if (!pack) throw new Error(`Unknown state tax pack: ${input.packId}`);
  if (pack.status !== "reviewed" && pack.status !== "active") {
    throw new Error(`State tax pack ${input.packId} is not approved for activation`);
  }

  const authorityId = await ensurePackAuthority(supabase, pack);
  const registrationId = await ensureRegistration(supabase, input, pack, authorityId);
  const rulesMaterialized = await materializeReferenceTaxabilityRules(supabase, input.organizationId, pack);

  await recordTaxAuditEvent(supabase, {
    organizationId: input.organizationId,
    eventType: "tax_registration_updated",
    entityType: "state_tax_pack",
    entityId: registrationId,
    payload: {
      action: "state_pack_activated",
      packId: pack.packId,
      packVersion: pack.version,
      state: pack.state,
      registrationId,
      rulesMaterialized,
    },
    createdBy: input.actorId ?? null,
  });

  return {
    registrationId,
    packId: pack.packId,
    packVersion: pack.version,
    rulesMaterialized,
    alreadyActive: rulesMaterialized === 0,
  };
}

async function ensurePackAuthority(supabase: SupabaseClient, pack: StateTaxPack): Promise<string | null> {
  const primary = pack.authorities[0];
  if (!primary) return null;

  const { data: existing } = await supabase
    .from("teller_tax_authorities")
    .select("id")
    .eq("authority_key", primary.authorityKey)
    .maybeSingle();

  if (existing?.id) return existing.id as string;

  const { data, error } = await supabase
    .from("teller_tax_authorities")
    .insert({
      authority_key: primary.authorityKey,
      name: primary.name,
      jurisdiction_key: primary.jurisdictionKey,
      admin_level: primary.adminLevel,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not persist tax authority");
  return data.id as string;
}

async function ensureRegistration(
  supabase: SupabaseClient,
  input: ActivateStateTaxPackInput,
  pack: StateTaxPack,
  authorityId: string | null,
): Promise<string> {
  const jurisdictionKey = `US-${pack.state}`;

  const { data: existingRows, error: existingError } = await supabase
    .from("teller_tax_registrations")
    .select("id, metadata")
    .eq("organization_id", input.organizationId)
    .eq("jurisdiction_key", jurisdictionKey)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1);
  if (existingError) throw new Error(existingError.message);
  const existing = existingRows?.[0] ?? null;

  const metadata = {
    ...((existing?.metadata as Record<string, unknown> | null) ?? {}),
    statePackId: pack.packId,
    statePackVersion: pack.version,
    statePackSlug: pack.slug,
    activatedAt: new Date().toISOString(),
  };

  if (existing?.id) {
    const { error } = await supabase
      .from("teller_tax_registrations")
      .update({
        authority_id: authorityId,
        registration_number: input.registrationNumber ?? null,
        filing_frequency: input.filingFrequency ?? "monthly",
        metadata,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
      .eq("organization_id", input.organizationId);
    if (error) throw new Error(error.message);
    return existing.id as string;
  }

  const { data, error } = await supabase
    .from("teller_tax_registrations")
    .insert({
      organization_id: input.organizationId,
      authority_id: authorityId,
      jurisdiction_key: jurisdictionKey,
      registration_number: input.registrationNumber ?? null,
      filing_frequency: input.filingFrequency ?? "monthly",
      status: "active",
      effective_from: input.effectiveFrom,
      metadata,
      created_by: input.actorId ?? null,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not create tax registration");
  return data.id as string;
}

async function materializeReferenceTaxabilityRules(
  supabase: SupabaseClient,
  organizationId: string,
  pack: StateTaxPack,
): Promise<number> {
  let inserted = 0;
  for (const rule of pack.taxabilityRules) {
    const { data: existing } = await supabase
      .from("teller_taxability_rules")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("jurisdiction_key", rule.jurisdictionKey)
      .eq("tax_category_key", rule.taxCategoryKey)
      .eq("source_kind", "reference_rule_set")
      .eq("rule_set_slug", pack.slug)
      .eq("effective_from", rule.effectiveFrom)
      .maybeSingle();

    if (existing?.id) continue;

    const { error } = await supabase.from("teller_taxability_rules").insert({
      organization_id: organizationId,
      jurisdiction_key: rule.jurisdictionKey,
      tax_category_key: rule.taxCategoryKey,
      treatment: rule.treatment,
      priority: rule.priority,
      effective_from: rule.effectiveFrom,
      effective_to: rule.effectiveTo ?? null,
      source_kind: "reference_rule_set",
      rule_set_slug: pack.slug,
      metadata: { sourceCitation: rule.sourceCitation, packVersion: pack.version },
    });
    if (error) throw new Error(error.message);
    inserted += 1;
  }
  return inserted;
}
