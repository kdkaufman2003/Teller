import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAuditEvent } from "../../audit";
import { assertBalanced } from "../../post";
import { roundMoney } from "../../payment-fees";
import { resolveConsolidationScope } from "../scope";
import type { EntityAuthContext } from "../../legal-entity/access";
import { buildConsolidationScopeKey } from "./scope-key";
import type {
  EliminationEntry,
  EliminationEntryType,
  EliminationLineInput,
  EliminationSourceKind,
  EliminationStatus,
} from "./types";

function mapEntry(row: Record<string, unknown>, lines: EliminationEntry["lines"], sources: EliminationEntry["sources"]): EliminationEntry {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    scopeKey: row.scope_key as string,
    legalEntityIds: (row.legal_entity_ids as string[]) ?? [],
    effectiveDate: (row.effective_date as string).slice(0, 10),
    periodStart: row.period_start ? (row.period_start as string).slice(0, 10) : null,
    periodEnd: row.period_end ? (row.period_end as string).slice(0, 10) : null,
    entryType: row.entry_type as EliminationEntryType,
    sourceKind: row.source_kind as EliminationSourceKind,
    status: row.status as EliminationStatus,
    description: (row.description as string) ?? "",
    memo: (row.memo as string) ?? "",
    currency: (row.currency as string) ?? "USD",
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.created_at as string,
    postedAt: (row.posted_at as string | null) ?? null,
    reversedAt: (row.reversed_at as string | null) ?? null,
    reversesEntryId: (row.reverses_entry_id as string | null) ?? null,
    reversalEntryId: (row.reversal_entry_id as string | null) ?? null,
    lines,
    sources,
  };
}

function validateBalancedLines(lines: EliminationLineInput[]) {
  const debit = roundMoney(lines.reduce((sum, line) => sum + (line.debit ?? 0), 0));
  const credit = roundMoney(lines.reduce((sum, line) => sum + (line.credit ?? 0), 0));
  if (Math.abs(debit - credit) > 0.009) {
    throw new Error("Elimination entry must balance");
  }
  assertBalanced(
    lines.map((line) => ({
      account_id: line.sourceAccountId ?? line.groupKey,
      debit: line.debit ?? 0,
      credit: line.credit ?? 0,
    })),
  );
}

export async function listConsolidationEliminations(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    scopeKey?: string | null;
    status?: EliminationStatus | null;
    auth?: EntityAuthContext;
  },
): Promise<EliminationEntry[]> {
  let query = supabase
    .from("teller_consolidation_elimination_entries")
    .select("*")
    .eq("organization_id", input.organizationId)
    .order("created_at", { ascending: false });
  if (input.scopeKey) query = query.eq("scope_key", input.scopeKey);
  if (input.status) query = query.eq("status", input.status);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return Promise.all(
    (data ?? []).map(async (row) => loadEntryDetails(supabase, row as Record<string, unknown>)),
  );
}

async function loadEntryDetails(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
): Promise<EliminationEntry> {
  const entryId = row.id as string;
  const [{ data: lines }, { data: sources }] = await Promise.all([
    supabase
      .from("teller_consolidation_elimination_lines")
      .select("*")
      .eq("entry_id", entryId)
      .order("line_number"),
    supabase.from("teller_consolidation_elimination_sources").select("*").eq("entry_id", entryId),
  ]);
  return mapEntry(
    row,
    (lines ?? []).map((line, index) => ({
      id: line.id as string,
      lineNumber: (line.line_number as number) ?? index + 1,
      groupKey: line.group_key as string,
      accountType: line.account_type as string,
      accountSubtype: (line.account_subtype as string) ?? "",
      accountCode: line.account_code as string,
      accountName: line.account_name as string,
      sourceLegalEntityId: (line.source_legal_entity_id as string | null) ?? null,
      sourceAccountId: (line.source_account_id as string | null) ?? null,
      debit: roundMoney(Number(line.debit)),
      credit: roundMoney(Number(line.credit)),
      memo: (line.memo as string) ?? "",
    })),
    (sources ?? []).map((source) => ({
      id: source.id as string,
      sourceKind: source.source_kind as string,
      sourceId: (source.source_id as string | null) ?? null,
      sourceReference: (source.source_reference as string | null) ?? null,
      metadata: (source.metadata as Record<string, unknown>) ?? {},
    })),
  );
}

export async function createConsolidationElimination(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityIds?: string[] | null;
    includeAllEntities?: boolean;
    effectiveDate: string;
    periodStart?: string | null;
    periodEnd?: string | null;
    entryType: EliminationEntryType;
    sourceKind?: EliminationSourceKind;
    status?: EliminationStatus;
    description: string;
    memo?: string;
    lines: EliminationLineInput[];
    sources?: Array<{
      sourceKind: string;
      sourceId?: string | null;
      sourceReference?: string | null;
      metadata?: Record<string, unknown>;
    }>;
    idempotencyKey?: string | null;
    auth?: EntityAuthContext;
    actorId?: string | null;
  },
): Promise<EliminationEntry> {
  validateBalancedLines(input.lines);
  const scope = await resolveConsolidationScope(supabase, {
    organizationId: input.organizationId,
    legalEntityIds: input.legalEntityIds,
    includeAllEntities: input.includeAllEntities,
    auth: input.auth,
  });
  const scopeKey = buildConsolidationScopeKey(input.organizationId, scope.entities.map((e) => e.legalEntityId));

  if (input.idempotencyKey) {
    const { data: existing } = await supabase
      .from("teller_consolidation_elimination_entries")
      .select("*")
      .eq("organization_id", input.organizationId)
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    if (existing?.id) return loadEntryDetails(supabase, existing as Record<string, unknown>);
  }

  const { data: entry, error } = await supabase
    .from("teller_consolidation_elimination_entries")
    .insert({
      organization_id: input.organizationId,
      scope_key: scopeKey,
      legal_entity_ids: scope.entities.map((entity) => entity.legalEntityId),
      effective_date: input.effectiveDate.slice(0, 10),
      period_start: input.periodStart?.slice(0, 10) ?? null,
      period_end: input.periodEnd?.slice(0, 10) ?? input.effectiveDate.slice(0, 10),
      entry_type: input.entryType,
      source_kind: input.sourceKind ?? "manual",
      status: input.status ?? "draft",
      description: input.description,
      memo: input.memo ?? "",
      idempotency_key: input.idempotencyKey ?? null,
      created_by: input.actorId ?? input.auth?.userId ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  const lineRows = input.lines.map((line, index) => ({
    organization_id: input.organizationId,
    entry_id: entry.id,
    line_number: index + 1,
    group_key: line.groupKey,
    account_type: line.accountType,
    account_subtype: line.accountSubtype ?? "",
    account_code: line.accountCode,
    account_name: line.accountName,
    source_legal_entity_id: line.sourceLegalEntityId ?? null,
    source_account_id: line.sourceAccountId ?? null,
    debit: line.debit ?? 0,
    credit: line.credit ?? 0,
    memo: line.memo ?? "",
  }));
  const { error: lineError } = await supabase.from("teller_consolidation_elimination_lines").insert(lineRows);
  if (lineError) throw new Error(lineError.message);

  if (input.sources?.length) {
    const { error: sourceError } = await supabase.from("teller_consolidation_elimination_sources").insert(
      input.sources.map((source) => ({
        organization_id: input.organizationId,
        entry_id: entry.id,
        source_kind: source.sourceKind,
        source_id: source.sourceId ?? null,
        source_reference: source.sourceReference ?? null,
        metadata: source.metadata ?? {},
      })),
    );
    if (sourceError) throw new Error(sourceError.message);
  }

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId ?? input.auth?.userId,
    action: "consolidation.elimination.created",
    resourceKind: "consolidation_elimination",
    resourceId: entry.id as string,
    metadata: { entryType: input.entryType, scopeKey },
  });

  return loadEntryDetails(supabase, entry as Record<string, unknown>);
}

export async function approveConsolidationElimination(
  supabase: SupabaseClient,
  input: { organizationId: string; entryId: string; actorId?: string | null; auth?: EntityAuthContext },
): Promise<EliminationEntry> {
  const { data, error } = await supabase
    .from("teller_consolidation_elimination_entries")
    .update({
      status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: input.actorId ?? input.auth?.userId ?? null,
    })
    .eq("organization_id", input.organizationId)
    .eq("id", input.entryId)
    .in("status", ["draft", "suggested"])
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error("Elimination entry not found or not approvable");

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId ?? input.auth?.userId,
    action: "consolidation.elimination.approved",
    resourceKind: "consolidation_elimination",
    resourceId: input.entryId,
  });

  return loadEntryDetails(supabase, data as Record<string, unknown>);
}

export async function postConsolidationElimination(
  supabase: SupabaseClient,
  input: { organizationId: string; entryId: string; actorId?: string | null; auth?: EntityAuthContext },
): Promise<EliminationEntry> {
  const { data, error } = await supabase.rpc("teller_atomic_post_consolidation_elimination", {
    p_entry_id: input.entryId,
    p_actor_id: input.actorId ?? input.auth?.userId ?? null,
  });
  if (error) throw new Error(error.message);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId ?? input.auth?.userId,
    action: "consolidation.elimination.posted",
    resourceKind: "consolidation_elimination",
    resourceId: input.entryId,
    metadata: data as Record<string, unknown>,
  });

  const { data: entry, error: loadError } = await supabase
    .from("teller_consolidation_elimination_entries")
    .select("*")
    .eq("id", input.entryId)
    .single();
  if (loadError) throw new Error(loadError.message);
  return loadEntryDetails(supabase, entry as Record<string, unknown>);
}

export async function reverseConsolidationElimination(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    entryId: string;
    actorId?: string | null;
    auth?: EntityAuthContext;
    idempotencyKey?: string | null;
  },
): Promise<{ reversalEntryId: string; duplicate?: boolean }> {
  const { data, error } = await supabase.rpc("teller_atomic_reverse_consolidation_elimination", {
    p_entry_id: input.entryId,
    p_actor_id: input.actorId ?? input.auth?.userId ?? null,
    p_idempotency_key: input.idempotencyKey ?? null,
  });
  if (error) throw new Error(error.message);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId ?? input.auth?.userId,
    action: "consolidation.elimination.reversed",
    resourceKind: "consolidation_elimination",
    resourceId: input.entryId,
    metadata: data as Record<string, unknown>,
  });

  return {
    reversalEntryId: String((data as Record<string, unknown>).entry_id),
    duplicate: Boolean((data as Record<string, unknown>).duplicate),
  };
}
