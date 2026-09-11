import type { SupabaseClient } from "@supabase/supabase-js";
import { recordTaxAuditEvent } from "../audit";
import { generateFilingPeriodsForRegistration } from "./period-generation";
import { assertFilingPeriodTransition, isImmutableFilingPeriodStatus } from "./period-status";
import { reconcileTaxPeriod, TAX_PERIOD_RECONCILIATION_VERSION } from "./reconcile";
import type { TaxFilingPeriodRecord, TaxFilingPeriodStatus, TaxRegistrationRecord } from "./types";

function parseRegistration(row: Record<string, unknown>): TaxRegistrationRecord {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    authorityId: (row.authority_id as string | null) ?? null,
    jurisdictionKey: (row.jurisdiction_key as string | null) ?? null,
    registrationNumber: (row.registration_number as string | null) ?? null,
    filingFrequency: row.filing_frequency as TaxRegistrationRecord["filingFrequency"],
    status: row.status as TaxRegistrationRecord["status"],
    effectiveFrom: row.effective_from as string,
    effectiveTo: (row.effective_to as string | null) ?? null,
  };
}

function parsePeriod(row: Record<string, unknown>): TaxFilingPeriodRecord {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    registrationId: row.registration_id as string,
    authorityId: (row.authority_id as string | null) ?? null,
    jurisdictionKey: (row.jurisdiction_key as string | null) ?? null,
    periodStart: row.period_start as string,
    periodEnd: row.period_end as string,
    filingFrequency: row.filing_frequency as TaxFilingPeriodRecord["filingFrequency"],
    status: row.status as TaxFilingPeriodRecord["status"],
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
  };
}

export async function generateTaxFilingPeriods(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    registrationId: string;
    rangeStart: string;
    rangeEnd: string;
  },
): Promise<TaxFilingPeriodRecord[]> {
  const { data: registrationRow, error } = await supabase
    .from("teller_tax_registrations")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("id", input.registrationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!registrationRow) throw new Error("Tax registration not found");

  const registration = parseRegistration(registrationRow as Record<string, unknown>);
  const generated = generateFilingPeriodsForRegistration(
    registration,
    input.rangeStart,
    input.rangeEnd,
  );

  const persisted: TaxFilingPeriodRecord[] = [];
  for (const period of generated) {
    const { data, error: upsertError } = await supabase
      .from("teller_tax_filing_periods")
      .upsert(
        {
          organization_id: input.organizationId,
          registration_id: registration.id,
          authority_id: registration.authorityId ?? null,
          jurisdiction_key: registration.jurisdictionKey ?? null,
          period_start: period.periodStart,
          period_end: period.periodEnd,
          filing_frequency: period.filingFrequency,
          status: "open",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "organization_id,registration_id,period_start,period_end" },
      )
      .select("*")
      .single();
    if (upsertError || !data) throw new Error(upsertError?.message || "Could not persist filing period");
    persisted.push(parsePeriod(data as Record<string, unknown>));
  }

  return persisted;
}

export async function listTaxFilingPeriods(
  supabase: SupabaseClient,
  organizationId: string,
  filters?: { registrationId?: string; status?: TaxFilingPeriodStatus },
): Promise<TaxFilingPeriodRecord[]> {
  let query = supabase
    .from("teller_tax_filing_periods")
    .select("*")
    .eq("organization_id", organizationId)
    .order("period_start", { ascending: false });

  if (filters?.registrationId) query = query.eq("registration_id", filters.registrationId);
  if (filters?.status) query = query.eq("status", filters.status);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => parsePeriod(row as Record<string, unknown>));
}

export async function reconcileAndPersistTaxPeriod(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    filingPeriodId: string;
    actorId?: string | null;
  },
) {
  const { data: periodRow, error: periodError } = await supabase
    .from("teller_tax_filing_periods")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("id", input.filingPeriodId)
    .maybeSingle();
  if (periodError) throw new Error(periodError.message);
  if (!periodRow) throw new Error("Filing period not found");

  const period = parsePeriod(periodRow as Record<string, unknown>);
  const result = await reconcileTaxPeriod(supabase, {
    organizationId: input.organizationId,
    registrationId: period.registrationId,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    filingPeriodId: period.id,
  });

  const metadata = {
    ...period.metadata,
    lastReconciliation: {
      version: TAX_PERIOD_RECONCILIATION_VERSION,
      reconciledAt: new Date().toISOString(),
      ...result,
      period: undefined,
      registration: undefined,
    },
  };

  const nextStatus: TaxFilingPeriodStatus = result.readiness.ready
    ? period.status === "open" || period.status === "needs_review"
      ? "ready_for_review"
      : period.status
    : "needs_review";

  if (!isImmutableFilingPeriodStatus(period.status)) {
    assertFilingPeriodTransition(period.status, nextStatus);
  }

  const { error: updateError } = await supabase
    .from("teller_tax_filing_periods")
    .update({
      status: isImmutableFilingPeriodStatus(period.status) ? period.status : nextStatus,
      metadata,
      updated_at: new Date().toISOString(),
    })
    .eq("id", period.id)
    .eq("organization_id", input.organizationId);
  if (updateError) throw new Error(updateError.message);

  const { error: snapshotError } = await supabase.from("teller_tax_filing_period_snapshots").insert({
    organization_id: input.organizationId,
    filing_period_id: period.id,
    snapshot_kind: "reconciliation",
    payload: {
      version: TAX_PERIOD_RECONCILIATION_VERSION,
      reconciledAt: new Date().toISOString(),
      result,
    },
  });
  if (snapshotError) throw new Error(snapshotError.message);

  await recordTaxAuditEvent(supabase, {
    organizationId: input.organizationId,
    eventType: "tax_filing_period_status_changed",
    entityType: "tax_filing_period",
    entityId: period.id,
    payload: { status: nextStatus, readiness: result.readiness },
    createdBy: input.actorId ?? null,
  });

  return result;
}

export async function transitionTaxFilingPeriodStatus(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    filingPeriodId: string;
    toStatus: TaxFilingPeriodStatus;
    actorId?: string | null;
  },
): Promise<TaxFilingPeriodRecord> {
  const { data: periodRow, error } = await supabase
    .from("teller_tax_filing_periods")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("id", input.filingPeriodId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!periodRow) throw new Error("Filing period not found");

  const period = parsePeriod(periodRow as Record<string, unknown>);
  if (isImmutableFilingPeriodStatus(period.status) && input.toStatus !== period.status) {
    throw new Error("Filed filing periods are immutable");
  }
  assertFilingPeriodTransition(period.status, input.toStatus);

  const reconciliation =
    input.toStatus === "reviewed" || input.toStatus === "filed"
      ? await reconcileTaxPeriod(supabase, {
          organizationId: input.organizationId,
          registrationId: period.registrationId,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          filingPeriodId: period.id,
        })
      : null;

  if (reconciliation && !reconciliation.readiness.ready && input.toStatus !== "needs_review") {
    throw new Error("Filing period is not ready for review");
  }

  const { data: updated, error: updateError } = await supabase
    .from("teller_tax_filing_periods")
    .update({ status: input.toStatus, updated_at: new Date().toISOString() })
    .eq("id", period.id)
    .eq("organization_id", input.organizationId)
    .select("*")
    .single();
  if (updateError || !updated) throw new Error(updateError?.message || "Could not update filing period");

  if (reconciliation && (input.toStatus === "reviewed" || input.toStatus === "filed")) {
    await supabase.from("teller_tax_filing_period_snapshots").insert({
      organization_id: input.organizationId,
      filing_period_id: period.id,
      snapshot_kind: input.toStatus,
      payload: {
        version: TAX_PERIOD_RECONCILIATION_VERSION,
        capturedAt: new Date().toISOString(),
        reconciliation,
      },
    });
  }

  await recordTaxAuditEvent(supabase, {
    organizationId: input.organizationId,
    eventType: "tax_filing_period_status_changed",
    entityType: "tax_filing_period",
    entityId: period.id,
    payload: { from: period.status, to: input.toStatus },
    createdBy: input.actorId ?? null,
  });

  return parsePeriod(updated as Record<string, unknown>);
}
