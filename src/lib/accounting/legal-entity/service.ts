import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAuditEvent } from "../audit";
import { resolveDefaultLegalEntity } from "./resolver";
import type { CreateLegalEntityInput, LegalEntitySummary, UpdateLegalEntityInput } from "./types";
import { normalizeEntityCode, parseLegalEntityType, validateEntityCode } from "./validation";

export async function organizationHasActiveHfacIntegration(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("teller_integrations")
    .select("enabled")
    .eq("organization_id", organizationId)
    .eq("provider", "hfac")
    .maybeSingle();

  if (error) throw new Error(error.message);
  return Boolean(data?.enabled);
}

function mapRow(row: Record<string, unknown>): LegalEntitySummary {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    name: row.name as string,
    legalName: row.legal_name as string,
    entityCode: row.entity_code as string,
    entityType: row.entity_type as LegalEntitySummary["entityType"],
    baseCurrency: row.base_currency as string,
    isDefault: Boolean(row.is_default),
    isActive: Boolean(row.is_active),
    consolidationEnabled: Boolean(row.consolidation_enabled),
  };
}

export async function listLegalEntities(
  supabase: SupabaseClient,
  organizationId: string,
  options?: { includeInactive?: boolean },
): Promise<LegalEntitySummary[]> {
  let query = supabase
    .from("teller_legal_entities")
    .select("*")
    .eq("organization_id", organizationId)
    .order("is_default", { ascending: false })
    .order("name");

  if (!options?.includeInactive) {
    query = query.eq("is_active", true);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => mapRow(row));
}

export async function createLegalEntity(
  supabase: SupabaseClient,
  input: CreateLegalEntityInput,
): Promise<LegalEntitySummary> {
  const codeCheck = validateEntityCode(input.entityCode);
  if (!codeCheck.ok) throw new Error(codeCheck.reason);

  const entityCode = normalizeEntityCode(input.entityCode);
  const name = input.name.trim();
  if (!name) throw new Error("Legal entity name is required");

  const wantsDefault = Boolean(input.isDefault);
  if (wantsDefault) {
    const existingDefault = await resolveDefaultLegalEntity(supabase, input.organizationId);
    if (existingDefault) {
      throw new Error("Organization already has a default legal entity");
    }
  }

  const { data, error } = await supabase
    .from("teller_legal_entities")
    .insert({
      organization_id: input.organizationId,
      name,
      legal_name: (input.legalName ?? name).trim() || name,
      entity_code: entityCode,
      entity_type: parseLegalEntityType(input.entityType),
      country_code: (input.countryCode ?? "US").trim() || "US",
      state_code: (input.stateCode ?? "").trim(),
      base_currency: (input.baseCurrency ?? "USD").trim() || "USD",
      is_default: wantsDefault,
      is_active: true,
    })
    .select("*")
    .single();

  if (error) {
    if (/duplicate key|unique/i.test(error.message)) {
      throw new Error(`Entity code ${entityCode} already exists in this organization`);
    }
    if (/one_default_per_org/i.test(error.message)) {
      throw new Error("Organization already has a default legal entity");
    }
    throw new Error(error.message);
  }

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "legal_entity.created",
    resourceKind: "legal_entity",
    resourceId: data.id as string,
    metadata: { entityCode, isDefault: wantsDefault },
  });

  return mapRow(data);
}

export async function archiveLegalEntity(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId: string;
    actorId?: string | null;
  },
): Promise<LegalEntitySummary> {
  const { data: current, error: loadError } = await supabase
    .from("teller_legal_entities")
    .select("*")
    .eq("id", input.legalEntityId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();

  if (loadError) throw new Error(loadError.message);
  if (!current) throw new Error("Legal entity not found");
  if (current.is_default) {
    throw new Error("Default legal entity cannot be archived");
  }

  const { data, error } = await supabase
    .from("teller_legal_entities")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", input.legalEntityId)
    .eq("organization_id", input.organizationId)
    .select("*")
    .single();

  if (error) throw new Error(error.message);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "legal_entity.archived",
    resourceKind: "legal_entity",
    resourceId: input.legalEntityId,
  });

  return mapRow(data);
}

export async function updateLegalEntity(
  supabase: SupabaseClient,
  input: UpdateLegalEntityInput,
): Promise<LegalEntitySummary> {
  const { data: current, error: loadError } = await supabase
    .from("teller_legal_entities")
    .select("*")
    .eq("id", input.legalEntityId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();

  if (loadError) throw new Error(loadError.message);
  if (!current) throw new Error("Legal entity not found");

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error("Legal entity name is required");
    patch.name = name;
  }
  if (input.legalName !== undefined) {
    patch.legal_name = input.legalName.trim() || (patch.name as string) || current.name;
  }
  if (input.entityType !== undefined) patch.entity_type = parseLegalEntityType(input.entityType);
  if (input.countryCode !== undefined) patch.country_code = input.countryCode.trim() || "US";
  if (input.stateCode !== undefined) patch.state_code = input.stateCode.trim();
  if (input.baseCurrency !== undefined) patch.base_currency = input.baseCurrency.trim() || "USD";

  const { data, error } = await supabase
    .from("teller_legal_entities")
    .update(patch)
    .eq("id", input.legalEntityId)
    .eq("organization_id", input.organizationId)
    .select("*")
    .single();

  if (error) throw new Error(error.message);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "legal_entity.updated",
    resourceKind: "legal_entity",
    resourceId: input.legalEntityId,
    metadata: { entityCode: current.entity_code },
  });

  return mapRow(data);
}

export async function setDefaultLegalEntity(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId: string;
    actorId?: string | null;
  },
): Promise<LegalEntitySummary> {
  const { data: currentDefault } = await supabase
    .from("teller_legal_entities")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("is_default", true)
    .eq("is_active", true)
    .maybeSingle();

  if (currentDefault?.id === input.legalEntityId) {
    const { data, error } = await supabase
      .from("teller_legal_entities")
      .select("*")
      .eq("id", input.legalEntityId)
      .eq("organization_id", input.organizationId)
      .single();
    if (error) throw new Error(error.message);
    return mapRow(data);
  }

  const { data, error } = await supabase.rpc("teller_set_default_legal_entity", {
    p_org_id: input.organizationId,
    p_entity_id: input.legalEntityId,
  });

  if (error) {
    if (/hfac|hassle free ac/i.test(error.message)) {
      throw new Error(error.message);
    }
    throw new Error(error.message);
  }

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "legal_entity.default_changed",
    resourceKind: "legal_entity",
    resourceId: input.legalEntityId,
    metadata: {
      previousDefaultEntityId: currentDefault?.id ?? null,
      newDefaultEntityId: input.legalEntityId,
    },
  });

  const { data: entity, error: loadError } = await supabase
    .from("teller_legal_entities")
    .select("*")
    .eq("id", data ?? input.legalEntityId)
    .single();

  if (loadError) throw new Error(loadError.message);
  return mapRow(entity);
}

export async function seedDefaultLegalEntityViaRpc(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<string> {
  const { data, error } = await supabase.rpc("teller_seed_default_legal_entity", {
    p_org_id: organizationId,
  });
  if (error) throw new Error(error.message);
  return data as string;
}
