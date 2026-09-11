import type { SupabaseClient } from "@supabase/supabase-js";
import { assertSameOrganization } from "../tenant-isolation";
import { recordTaxExemptionAuditEvent } from "./audit";
import { deriveLifecycleStatus, maskCertificateNumber, parseTaxExemptionRow } from "./parse";
import { expirationWarningLevel } from "./validity";
import type {
  CreateTaxExemptionInput,
  ParsedTaxExemption,
  TaxExemptionRow,
  UpdateTaxExemptionInput,
} from "./types";

async function assertPartyInOrg(
  supabase: SupabaseClient,
  organizationId: string,
  partyId: string,
): Promise<void> {
  const { data: party } = await supabase
    .from("teller_parties")
    .select("organization_id")
    .eq("id", partyId)
    .maybeSingle();
  assertSameOrganization(organizationId, party?.organization_id ?? null, "Customer");
}

async function findDuplicateWarning(
  supabase: SupabaseClient,
  organizationId: string,
  partyId: string,
  certificateNumber: string | null | undefined,
  issuingJurisdictionKey: string | null | undefined,
  excludeId?: string,
): Promise<boolean> {
  if (!certificateNumber?.trim()) return false;
  let query = supabase
    .from("teller_tax_exemptions")
    .select("id, metadata")
    .eq("organization_id", organizationId)
    .eq("party_id", partyId)
    .eq("certificate_number", certificateNumber.trim());
  if (excludeId) query = query.neq("id", excludeId);
  const { data } = await query;
  if (!data?.length) return false;
  if (!issuingJurisdictionKey) return true;
  return data.some((row) => {
    const meta = row.metadata as Record<string, unknown> | null;
    return meta?.issuingJurisdictionKey === issuingJurisdictionKey;
  });
}

function buildMetadata(
  input: Partial<CreateTaxExemptionInput> & { duplicateWarning?: boolean },
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...existing,
    certificateType: input.certificateType ?? existing.certificateType ?? "other",
    issuingJurisdictionKey:
      input.issuingJurisdictionKey ?? existing.issuingJurisdictionKey ?? null,
    reviewStatus: existing.reviewStatus ?? "draft",
    notes: input.notes ?? existing.notes ?? null,
    attachmentStoragePath:
      input.attachmentStoragePath ?? existing.attachmentStoragePath ?? null,
    attachmentFileName: input.attachmentFileName ?? existing.attachmentFileName ?? null,
    source: input.source ?? existing.source ?? "manual",
    duplicateWarning: input.duplicateWarning ?? existing.duplicateWarning ?? false,
  };
}

export async function getTaxExemptionById(
  supabase: SupabaseClient,
  organizationId: string,
  exemptionId: string,
): Promise<ParsedTaxExemption | null> {
  const { data, error } = await supabase
    .from("teller_tax_exemptions")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", exemptionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return parseTaxExemptionRow(data as TaxExemptionRow);
}

export async function createTaxExemption(
  supabase: SupabaseClient,
  organizationId: string,
  input: CreateTaxExemptionInput,
  actorId?: string | null,
): Promise<ParsedTaxExemption> {
  await assertPartyInOrg(supabase, organizationId, input.partyId);
  const duplicateWarning = await findDuplicateWarning(
    supabase,
    organizationId,
    input.partyId,
    input.certificateNumber,
    input.issuingJurisdictionKey,
  );

  const { data, error } = await supabase
    .from("teller_tax_exemptions")
    .insert({
      organization_id: organizationId,
      party_id: input.partyId,
      certificate_number: input.certificateNumber?.trim() || null,
      certificate_on_file: input.certificateOnFile ?? false,
      jurisdiction_scope: input.jurisdictionScope,
      category_scope: input.categoryScope.length > 0 ? input.categoryScope : ["*"],
      status: "pending",
      effective_from: input.effectiveFrom,
      effective_to: input.effectiveTo ?? null,
      metadata: buildMetadata({ ...input, duplicateWarning }),
      created_by: actorId ?? null,
    })
    .select("*")
    .single();

  if (error || !data) throw new Error(error?.message || "Could not create exemption");

  await recordTaxExemptionAuditEvent(supabase, {
    organizationId,
    eventType: "tax_exemption_created",
    entityId: data.id,
    payload: { partyId: input.partyId, status: "pending" },
    createdBy: actorId,
  });

  return parseTaxExemptionRow(data as TaxExemptionRow);
}

export async function updateTaxExemption(
  supabase: SupabaseClient,
  organizationId: string,
  exemptionId: string,
  input: UpdateTaxExemptionInput,
  actorId?: string | null,
): Promise<ParsedTaxExemption> {
  const existing = await getTaxExemptionById(supabase, organizationId, exemptionId);
  if (!existing) throw new Error("Exemption not found");
  if (existing.status === "active") {
    throw new Error("Active exemption certificates cannot be silently rewritten — revoke and create a replacement");
  }

  const duplicateWarning = await findDuplicateWarning(
    supabase,
    organizationId,
    existing.partyId!,
    input.certificateNumber ?? existing.certificateNumber,
    input.issuingJurisdictionKey ?? existing.issuingJurisdictionKey,
    exemptionId,
  );

  const nextMetadata = buildMetadata(
    {
      certificateType: input.certificateType ?? existing.certificateType ?? undefined,
      issuingJurisdictionKey: input.issuingJurisdictionKey ?? existing.issuingJurisdictionKey,
      notes: input.notes ?? existing.notes ?? undefined,
      attachmentStoragePath: input.attachmentStoragePath ?? existing.metadata.attachmentStoragePath ?? undefined,
      attachmentFileName: input.attachmentFileName ?? existing.metadata.attachmentFileName ?? undefined,
      duplicateWarning,
    },
    existing.metadata as Record<string, unknown>,
  );

  const { data, error } = await supabase
    .from("teller_tax_exemptions")
    .update({
      certificate_number:
        input.certificateNumber !== undefined
          ? input.certificateNumber?.trim() || null
          : existing.certificateNumber,
      certificate_on_file:
        input.certificateOnFile !== undefined ? input.certificateOnFile : existing.certificateOnFile,
      jurisdiction_scope: input.jurisdictionScope ?? existing.jurisdictionScope,
      category_scope: input.categoryScope ?? existing.categoryScope,
      effective_from: input.effectiveFrom ?? existing.effectiveFrom,
      effective_to: input.effectiveTo !== undefined ? input.effectiveTo : existing.effectiveTo,
      metadata: nextMetadata,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", organizationId)
    .eq("id", exemptionId)
    .select("*")
    .single();

  if (error || !data) throw new Error(error?.message || "Could not update exemption");

  await recordTaxExemptionAuditEvent(supabase, {
    organizationId,
    eventType: "tax_exemption_changed",
    entityId: exemptionId,
    payload: { action: "updated" },
    createdBy: actorId,
  });

  return parseTaxExemptionRow(data as TaxExemptionRow);
}

export async function activateTaxExemption(
  supabase: SupabaseClient,
  organizationId: string,
  exemptionId: string,
  actorId?: string | null,
): Promise<ParsedTaxExemption> {
  const existing = await getTaxExemptionById(supabase, organizationId, exemptionId);
  if (!existing) throw new Error("Exemption not found");
  if (existing.jurisdictionScope.length === 0) {
    throw new Error("Jurisdiction scope is required before activation");
  }

  const metadata = {
    ...existing.metadata,
    reviewStatus: "approved" as const,
  };

  const { data, error } = await supabase
    .from("teller_tax_exemptions")
    .update({
      status: "active",
      metadata,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", organizationId)
    .eq("id", exemptionId)
    .select("*")
    .single();

  if (error || !data) throw new Error(error?.message || "Could not activate exemption");

  await recordTaxExemptionAuditEvent(supabase, {
    organizationId,
    eventType: "tax_exemption_changed",
    entityId: exemptionId,
    payload: { action: "activated" },
    createdBy: actorId,
  });

  return parseTaxExemptionRow(data as TaxExemptionRow);
}

export async function revokeTaxExemption(
  supabase: SupabaseClient,
  organizationId: string,
  exemptionId: string,
  revokedEffectiveFrom: string,
  actorId?: string | null,
): Promise<ParsedTaxExemption> {
  const existing = await getTaxExemptionById(supabase, organizationId, exemptionId);
  if (!existing) throw new Error("Exemption not found");

  const metadata = {
    ...existing.metadata,
    revokedEffectiveFrom,
  };

  const { data, error } = await supabase
    .from("teller_tax_exemptions")
    .update({
      status: "inactive",
      metadata,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", organizationId)
    .eq("id", exemptionId)
    .select("*")
    .single();

  if (error || !data) throw new Error(error?.message || "Could not revoke exemption");

  await recordTaxExemptionAuditEvent(supabase, {
    organizationId,
    eventType: "tax_exemption_changed",
    entityId: exemptionId,
    payload: { action: "revoked", revokedEffectiveFrom },
    createdBy: actorId,
  });

  return parseTaxExemptionRow(data as TaxExemptionRow);
}

export async function rejectTaxExemption(
  supabase: SupabaseClient,
  organizationId: string,
  exemptionId: string,
  reason?: string,
  actorId?: string | null,
): Promise<ParsedTaxExemption> {
  const existing = await getTaxExemptionById(supabase, organizationId, exemptionId);
  if (!existing) throw new Error("Exemption not found");

  const metadata = {
    ...existing.metadata,
    reviewStatus: "rejected" as const,
    rejectedAt: new Date().toISOString().slice(0, 10),
    rejectionReason: reason ?? null,
  };

  const { data, error } = await supabase
    .from("teller_tax_exemptions")
    .update({
      status: "inactive",
      metadata,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", organizationId)
    .eq("id", exemptionId)
    .select("*")
    .single();

  if (error || !data) throw new Error(error?.message || "Could not reject exemption");

  await recordTaxExemptionAuditEvent(supabase, {
    organizationId,
    eventType: "tax_exemption_changed",
    entityId: exemptionId,
    payload: { action: "rejected", reason: reason ?? null },
    createdBy: actorId,
  });

  return parseTaxExemptionRow(data as TaxExemptionRow);
}

export function serializeExemptionForClient(exemption: ParsedTaxExemption, mode: "owner" | "accountant" = "owner") {
  return {
    id: exemption.id,
    partyId: exemption.partyId,
    certificateNumber:
      mode === "accountant" ? exemption.certificateNumber ?? "—" : maskCertificateNumber(exemption.certificateNumber),
    certificateType: exemption.certificateType,
    issuingJurisdictionKey: exemption.issuingJurisdictionKey,
    jurisdictionScope: exemption.jurisdictionScope,
    categoryScope: exemption.categoryScope,
    effectiveFrom: exemption.effectiveFrom,
    effectiveTo: exemption.effectiveTo,
    status: exemption.status,
    lifecycleStatus: exemption.lifecycleStatus,
    reviewStatus: exemption.reviewStatus,
    certificateOnFile: exemption.certificateOnFile,
    notes: exemption.notes,
    duplicateWarning: exemption.metadata.duplicateWarning ?? false,
    expirationWarning: expirationWarningLevel(exemption, new Date().toISOString().slice(0, 10)),
  };
}
