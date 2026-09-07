import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { recordAuditEvent } from "./audit";
import { loadFixedAsset, recordFixedAssetJournalLink } from "./fixed-assets";
import type { DisposalType } from "./fixed-asset-types";
import { assertOrgPeriodOpen, reverseJournalEntry } from "./post";
import { roundMoney } from "./payment-fees";

const DISPOSAL_OPERATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DisposeFixedAssetInput = {
  organizationId: string;
  assetId: string;
  disposalDate: string;
  disposalType: DisposalType;
  proceeds?: number;
  cashAccountId?: string | null;
  reason?: string;
  /** Client-generated UUID for this disposal operation; reuse on retries. */
  operationId: string;
  actorId?: string | null;
};

export type DisposeFixedAssetResult = {
  asset: Awaited<ReturnType<typeof loadFixedAsset>>;
  disposalEntryId: string;
  nbv: number;
  gainLoss: number;
  depreciationJournalEntryIds: string[];
  duplicate: boolean;
  operationId: string;
};

/** Validates disposal operation UUID before any accounting RPC. */
export function assertValidDisposalOperationId(operationId: unknown): asserts operationId is string {
  if (typeof operationId !== "string" || !operationId.trim()) {
    throw new Error("operationId is required");
  }
  if (!DISPOSAL_OPERATION_ID_RE.test(operationId.trim())) {
    throw new Error("operationId must be a valid UUID");
  }
}

function parseDisposeRpcPayload(data: unknown): {
  disposalEntryId: string;
  nbv: number;
  gainLoss: number;
  depreciationJournalEntryIds: string[];
  duplicate: boolean;
} {
  if (!data || typeof data !== "object") throw new Error("Disposal RPC returned no result");
  const payload = data as {
    disposal_journal_entry_id: string;
    depreciation_journal_entry_ids?: string[];
    net_book_value: number;
    gain_loss: number;
    duplicate?: boolean;
  };
  return {
    disposalEntryId: payload.disposal_journal_entry_id,
    nbv: asNumber(payload.net_book_value),
    gainLoss: asNumber(payload.gain_loss),
    depreciationJournalEntryIds: (payload.depreciation_journal_entry_ids ?? []) as string[],
    duplicate: Boolean(payload.duplicate),
  };
}

/** Atomic disposal via teller_dispose_fixed_asset RPC (single DB transaction). */
export async function disposeFixedAsset(
  supabase: SupabaseClient,
  input: DisposeFixedAssetInput,
): Promise<DisposeFixedAssetResult> {
  assertValidDisposalOperationId(input.operationId);
  const operationId = input.operationId.trim();
  const proceeds = roundMoney(asNumber(input.proceeds));

  const { data, error } = await supabase.rpc("teller_dispose_fixed_asset", {
    p_organization_id: input.organizationId,
    p_asset_id: input.assetId,
    p_disposal_date: input.disposalDate,
    p_disposal_type: input.disposalType,
    p_proceeds: proceeds,
    p_cash_account_id: input.cashAccountId ?? null,
    p_reason: input.reason?.trim() ?? "",
    p_idempotency_key: operationId,
    p_actor_id: input.actorId ?? null,
  });

  if (error) throw new Error(error.message);

  const parsed = parseDisposeRpcPayload(data);
  const asset = await loadFixedAsset(supabase, input.organizationId, input.assetId);

  return {
    asset,
    ...parsed,
    operationId,
  };
}

/** Service-role controlled harness only — not for production app paths. */
export async function disposeFixedAssetControlledTest(
  supabase: SupabaseClient,
  input: DisposeFixedAssetInput & {
    simulateFailureAfter?: "after_depreciation" | "before_asset_update" | null;
  },
): Promise<DisposeFixedAssetResult> {
  assertValidDisposalOperationId(input.operationId);
  const operationId = input.operationId.trim();
  const proceeds = roundMoney(asNumber(input.proceeds));

  const { data, error } = await supabase.rpc("teller_dispose_fixed_asset_controlled_test", {
    p_organization_id: input.organizationId,
    p_asset_id: input.assetId,
    p_disposal_date: input.disposalDate,
    p_disposal_type: input.disposalType,
    p_proceeds: proceeds,
    p_cash_account_id: input.cashAccountId ?? null,
    p_reason: input.reason?.trim() ?? "",
    p_idempotency_key: operationId,
    p_actor_id: input.actorId ?? null,
    p_simulate_failure_after: input.simulateFailureAfter ?? null,
  });

  if (error) throw new Error(error.message);

  const parsed = parseDisposeRpcPayload(data);
  const asset = await loadFixedAsset(supabase, input.organizationId, input.assetId);

  return {
    asset,
    ...parsed,
    operationId,
  };
}

/**
 * Undo disposal reverses ONLY the disposal journal.
 * Disposal-period depreciation remains posted — reverse depreciation separately if needed.
 * Historical idempotency records for the original disposal are preserved.
 */
export async function undoFixedAssetDisposal(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    assetId: string;
    reversalDate: string;
    reason: string;
    actorId?: string | null;
  },
) {
  const asset = await loadFixedAsset(supabase, input.organizationId, input.assetId);
  if (asset.status !== "disposed") throw new Error("Asset is not disposed");
  if (!asset.disposal_journal_entry_id) throw new Error("Disposal journal missing");
  if (!input.reason.trim()) throw new Error("Undo disposal reason is required");

  await assertOrgPeriodOpen(supabase, input.organizationId, input.reversalDate);

  const reversalEntryId = await reverseJournalEntry(supabase, {
    organizationId: input.organizationId,
    entryId: asset.disposal_journal_entry_id,
    entryDate: input.reversalDate,
    memo: `Undo disposal ${asset.asset_number}: ${input.reason.trim()}`,
    sourceId: input.assetId,
    actorId: input.actorId,
  });

  const { data: updated, error } = await supabase
    .from("teller_fixed_assets")
    .update({
      status: "active",
      disposal_date: null,
      disposal_type: null,
      disposal_proceeds: 0,
      disposal_reason: "",
      disposal_journal_entry_id: null,
      updated_by: input.actorId ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", input.organizationId)
    .eq("id", input.assetId)
    .select("*")
    .single();
  if (error || !updated) throw new Error(error?.message || "Could not restore asset");

  await recordFixedAssetJournalLink(supabase, {
    organizationId: input.organizationId,
    fixedAssetId: input.assetId,
    journalEntryId: reversalEntryId,
    linkKind: "disposal_reversal",
  });

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "fixed_asset.disposal_reversed",
    resourceKind: "fixed_asset",
    resourceId: input.assetId,
    metadata: {
      reversalEntryId,
      reason: input.reason.trim(),
      note: "Depreciation posted during disposal is not automatically reversed",
    },
  });

  return { asset: updated, reversalEntryId };
}
