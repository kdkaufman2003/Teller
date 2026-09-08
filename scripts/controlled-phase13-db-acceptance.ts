/**
 * Phase 13 controlled DB acceptance — inventory + GRNI (mutates Phase 13 demo org only).
 */
import { randomUUID } from "crypto";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  CONTROLLED_PHASE13_DEMO_ORG_NAME,
  CONTROLLED_PHASE13_FOREIGN_ORG_NAME,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import {
  assertDistinctControlledDemoOrgIds,
  assertMutationScope,
  captureOrgEconomicFingerprint,
  capturePeerFingerprints,
  assertPeerFingerprintsUnchanged,
  type OrgEconomicFingerprint,
} from "../src/lib/integration/controlled-phase-isolation";
import { nextNumber } from "../src/lib/accounting/accounts";
import { postBillOpen, postBillPaid } from "../src/lib/accounting/bills";
import { buildJobProfitabilitySummary } from "../src/lib/accounting/job-profitability";
import { roundMoney } from "../src/lib/accounting/payment-fees";
import {
  createPurchaseOrder,
  submitPurchaseOrderForApproval,
  approvePurchaseOrder,
  markPurchaseOrderSent,
  receivePurchaseOrder,
} from "../src/lib/accounting/purchase-orders";
import {
  atomicReceiveInventory,
  atomicIssueInventory,
  atomicTransferInventory,
  atomicReverseInventoryMovement,
  atomicSettleInventoryReceiptBill,
  atomicReverseInventoryReceiptBillAllocation,
  inventoryAtomicRpcAvailable,
} from "../src/lib/accounting/inventory/atomic-rpc";
import { assertHfacInventoryHardRefusal } from "../src/lib/accounting/inventory/hfac-boundary";
import {
  buildGrniReceiptJournalLines,
  buildGrniBillSettlementJournalLines,
  buildUnbilledVendorReturnJournalLines,
} from "../src/lib/accounting/inventory/grni/journal-lines";
import {
  buildInventoryIssueJournalLines,
  buildOpeningInventoryJournalLines,
  buildInventoryDecreaseJournalLines,
  buildInventoryIncreaseJournalLines,
  reverseInventoryJournalLines,
  type InventoryJournalLine,
} from "../src/lib/accounting/inventory/journal-lines";
import {
  INVENTORY_ACCOUNT_MAPPING_KEYS,
  buildDefaultInventoryAccountMappings,
  type InventoryAccountMapping,
} from "../src/lib/accounting/inventory/grni/mappings";
import {
  canReverseReceipt,
  previewBillSettlement,
  grniSettlementIdempotencyKey,
  grniSettlementReversalIdempotencyKey,
  sumOpenGrniSubledger,
  type ReceiptOpenState,
} from "../src/lib/accounting/inventory/grni/settlement";
import { reconcileGrniSubledgerToGl } from "../src/lib/accounting/inventory/grni/reconciliation";
import {
  buildGrniAgingReport,
  buildPurchasePriceVarianceReport,
  buildAccountantGrniPackage,
} from "../src/lib/accounting/inventory/grni/reporting";
import { evaluateGrniCloseFindings } from "../src/lib/accounting/inventory/grni/close-integration";
import {
  reconcileInventorySubledgerToGl,
  reconcileInventoryCogs,
} from "../src/lib/accounting/inventory/reconciliation";
import {
  buildInventoryValuationSummary,
  buildAccountantInventoryPackage,
} from "../src/lib/accounting/inventory/reporting";
import { assertPaymentDoesNotAffectInventory } from "../src/lib/accounting/inventory/bill-integration";
import { INVENTORY_MOVEMENT_TYPES } from "../src/lib/accounting/inventory/types";

const PHASE13_DEMO_ORG_NAME = CONTROLLED_PHASE13_DEMO_ORG_NAME;
const HFAC_ORG = TELLER_HFAC_ORG_ID;
const ENTRY_DATE = "2026-11-15";

type Result = { name: string; pass: boolean; detail?: string };
type Flags = Record<string, boolean | string | number>;

type AccountBundle = {
  cashId: string;
  inventoryId: string;
  apId: string;
  grniId: string;
  obeId: string;
  cogsId: string;
  ppvId: string;
  shrinkageId: string;
  adjustmentGainId: string;
};

type BaseSetup = {
  vendorId: string;
  vendorName: string;
  jobId: string;
  itemId: string;
  itemSku: string;
  warehouseLocationId: string;
  truckLocationId: string;
  accounts: AccountBundle;
  mappings: InventoryAccountMapping[];
};

type RunCtx = BaseSetup & {
  orgId: string;
  supabase: SupabaseClient;
};

function loadEnv() {
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST=1 required");
  }
  const orgId = process.env.TELLER_PHASE13_DEMO_ORG_ID?.trim();
  if (!orgId) throw new Error("TELLER_PHASE13_DEMO_ORG_ID missing — run setup:phase13-demo-org");
  const foreignOrgId = process.env.TELLER_PHASE13_FOREIGN_ORG_ID?.trim();
  if (!foreignOrgId) throw new Error("TELLER_PHASE13_FOREIGN_ORG_ID missing — run setup:phase13-demo-org");
  const phase11_1OrgId = process.env.TELLER_PHASE11_1_DEMO_ORG_ID?.trim();
  if (!phase11_1OrgId) throw new Error("TELLER_PHASE11_1_DEMO_ORG_ID missing — required for peer isolation");
  assertNotHfacOrganization(orgId);
  assertNotHfacOrganization(foreignOrgId);
  assertNotHfacOrganization(phase11_1OrgId);
  assertDistinctControlledDemoOrgIds();
  if (orgId === foreignOrgId) throw new Error("Phase 13 demo org must differ from foreign test org");
  if (orgId === phase11_1OrgId) throw new Error("Phase 13 demo org must differ from Phase 11.1 demo org");
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return { orgId, foreignOrgId, phase11_1OrgId, supabase };
}

async function assertOrgName(supabase: SupabaseClient, orgId: string, expectedName: string) {
  const { data } = await supabase.from("teller_organizations").select("name").eq("id", orgId).single();
  if (data?.name !== expectedName) {
    throw new Error(`Expected "${expectedName}", got "${data?.name ?? "missing"}"`);
  }
}

async function accountMap(supabase: SupabaseClient, orgId: string) {
  const { data } = await supabase.from("teller_accounts").select("id, code, subtype").eq("organization_id", orgId);
  const byCode = new Map<string, string>();
  for (const row of data ?? []) byCode.set(row.code as string, row.id as string);
  return byCode;
}

function bundleAccounts(byCode: Map<string, string>): AccountBundle {
  return {
    cashId: byCode.get("1000")!,
    inventoryId: byCode.get("1200")!,
    apId: byCode.get("2000")!,
    grniId: byCode.get("2100")!,
    obeId: byCode.get("3000")!,
    cogsId: byCode.get("5000")!,
    ppvId: byCode.get("5205")!,
    shrinkageId: byCode.get("5100")!,
    adjustmentGainId: byCode.get("5110")!,
  };
}

function toRpcJournalLines(lines: InventoryJournalLine[]) {
  return lines.map((line) => ({
    account_id: line.accountId,
    debit: line.debit,
    credit: line.credit,
    memo: line.memo,
    job_id: line.jobId ?? null,
    cost_classification: line.costClassification ?? "",
  }));
}

async function journalLines(supabase: SupabaseClient, entryId: string) {
  const { data } = await supabase.from("teller_journal_lines").select("*").eq("entry_id", entryId);
  return data ?? [];
}

async function journalBalanced(supabase: SupabaseClient, entryId: string) {
  const lines = await journalLines(supabase, entryId);
  const d = lines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
  const c = lines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
  return Math.abs(d - c) < 0.01;
}

function lineAmount(
  lines: Array<{ account_id: string; debit?: number | null; credit?: number | null }>,
  accountId: string,
  side: "debit" | "credit",
) {
  return lines
    .filter((line) => line.account_id === accountId)
    .reduce((sum, line) => sum + Number(line[side] ?? 0), 0);
}

async function glBalance(supabase: SupabaseClient, orgId: string, accountId: string) {
  const { data: entries } = await supabase.from("teller_journal_entries").select("id").eq("organization_id", orgId);
  const ids = (entries ?? []).map((e) => e.id);
  if (!ids.length) return 0;
  const { data: lines } = await supabase
    .from("teller_journal_lines")
    .select("debit, credit")
    .in("entry_id", ids)
    .eq("account_id", accountId);
  return roundMoney((lines ?? []).reduce((s, l) => s + Number(l.debit ?? 0) - Number(l.credit ?? 0), 0));
}

async function getBalanceRow(supabase: SupabaseClient, orgId: string, itemId: string, locationId: string) {
  const { data } = await supabase
    .from("teller_inventory_balances")
    .select("*")
    .eq("organization_id", orgId)
    .eq("inventory_item_id", itemId)
    .eq("location_id", locationId)
    .maybeSingle();
  return data;
}

async function hfacSnapshot(supabase: SupabaseClient) {
  async function count(table: string) {
    const { count } = await supabase.from(table).select("id", { count: "exact", head: true }).eq("organization_id", HFAC_ORG);
    return count ?? 0;
  }
  return {
    documents: await count("teller_documents"),
    payments: await count("teller_payments"),
    journals: await count("teller_journal_entries"),
    phase13_items: await count("teller_inventory_items"),
    phase13_movements: await count("teller_inventory_movements"),
    phase13_grni_allocations: await count("teller_inventory_receipt_bill_allocations"),
  };
}

async function clearPhase13Org(supabase: SupabaseClient, orgId: string) {
  assertMutationScope(orgId, orgId, "clearPhase13Org");
  await supabase.from("teller_inventory_receipt_bill_allocations").delete().eq("organization_id", orgId);
  await supabase.from("teller_purchase_receipt_lines").delete().eq("organization_id", orgId);
  await supabase.from("teller_purchase_receipts").delete().eq("organization_id", orgId);
  await supabase.from("teller_inventory_movements").delete().eq("organization_id", orgId);
  await supabase.from("teller_inventory_transfer_groups").delete().eq("organization_id", orgId);
  await supabase.from("teller_inventory_count_lines").delete().eq("organization_id", orgId);
  await supabase.from("teller_inventory_counts").delete().eq("organization_id", orgId);
  await supabase.from("teller_inventory_balances").delete().eq("organization_id", orgId);
  await supabase.from("teller_purchase_order_lines").delete().eq("organization_id", orgId);
  await supabase.from("teller_purchase_orders").delete().eq("organization_id", orgId);
  const { data: docs } = await supabase.from("teller_documents").select("id").eq("organization_id", orgId);
  const docIds = (docs ?? []).map((row) => row.id as string);
  if (docIds.length) await supabase.from("teller_document_lines").delete().in("document_id", docIds);
  await supabase.from("teller_payments").delete().eq("organization_id", orgId);
  await supabase.from("teller_documents").delete().eq("organization_id", orgId);
  await supabase.from("teller_inventory_account_mappings").delete().eq("organization_id", orgId);
  await supabase.from("teller_inventory_items").delete().eq("organization_id", orgId);
  await supabase.from("teller_inventory_locations").delete().eq("organization_id", orgId);
  const { data: entries } = await supabase.from("teller_journal_entries").select("id").eq("organization_id", orgId);
  const ids = (entries ?? []).map((e) => e.id);
  if (ids.length) await supabase.from("teller_journal_lines").delete().in("entry_id", ids);
  await supabase.from("teller_journal_entries").delete().eq("organization_id", orgId);
  await supabase.from("teller_period_closes").delete().eq("organization_id", orgId);
  await supabase.from("teller_jobs").delete().eq("organization_id", orgId);
  await supabase.from("teller_parties").delete().eq("organization_id", orgId);
}

async function ensureLocation(
  supabase: SupabaseClient,
  orgId: string,
  name: string,
  locationType: string,
): Promise<string> {
  const { data: existing } = await supabase
    .from("teller_inventory_locations")
    .select("id")
    .eq("organization_id", orgId)
    .eq("name", name)
    .maybeSingle();
  if (existing?.id) return existing.id as string;
  const { data, error } = await supabase
    .from("teller_inventory_locations")
    .insert({
      organization_id: orgId,
      name,
      location_type: locationType,
      active: true,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? `location create failed: ${name}`);
  return data.id as string;
}

async function resetDemoOrg(
  supabase: SupabaseClient,
  orgId: string,
  accounts: AccountBundle,
): Promise<BaseSetup> {
  await clearPhase13Org(supabase, orgId);
  return ensureBaseSetup(supabase, orgId, accounts);
}

let poSeq = 0;
function nextIdempotency(prefix: string) {
  poSeq += 1;
  return `${prefix}-${Date.now()}-${poSeq}`;
}

async function ensureBaseSetup(supabase: SupabaseClient, orgId: string, accounts: AccountBundle): Promise<BaseSetup> {
  assertMutationScope(orgId, orgId, "ensureBaseSetup");
  const vendorName = "Phase 13 Demo Vendor";
  let vendorId: string;
  const { data: existingVendor } = await supabase
    .from("teller_parties")
    .select("id")
    .eq("organization_id", orgId)
    .eq("name", vendorName)
    .maybeSingle();
  if (existingVendor?.id) {
    vendorId = existingVendor.id as string;
  } else {
    const { data, error } = await supabase
      .from("teller_parties")
      .insert({ organization_id: orgId, name: vendorName, kind: "vendor" })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message ?? "vendor create failed");
    vendorId = data.id as string;
  }

  const { data: job, error: jobError } = await supabase
    .from("teller_jobs")
    .insert({
      organization_id: orgId,
      job_number: `P13-${Date.now().toString().slice(-6)}`,
      name: "Phase 13 Inventory Job",
      status: "active",
    })
    .select("id")
    .single();
  if (jobError || !job) throw new Error(jobError?.message ?? "job create failed");

  const itemSku = `P13-SKU-${Date.now().toString().slice(-5)}`;
  const { data: item, error: itemError } = await supabase
    .from("teller_inventory_items")
    .insert({
      organization_id: orgId,
      sku: itemSku,
      name: "Phase 13 Demo Part",
      item_type: "inventory",
      valuation_method: "weighted_average",
      unit_of_measure: "each",
      inventory_asset_account_id: accounts.inventoryId,
      cogs_account_id: accounts.cogsId,
      active: true,
    })
    .select("id, sku")
    .single();
  if (itemError || !item) throw new Error(itemError?.message ?? "item create failed");

  const warehouseLocationId = await ensureLocation(supabase, orgId, "Main Warehouse", "warehouse");
  const truckLocationId = await ensureLocation(supabase, orgId, "Truck 1", "vehicle");

  const mappings = buildDefaultInventoryAccountMappings({
    inventoryAssetAccountId: accounts.inventoryId,
    grniAccountId: accounts.grniId,
    ppvAccountId: accounts.ppvId,
    cogsAccountId: accounts.cogsId,
    adjustmentExpenseAccountId: accounts.shrinkageId,
    adjustmentGainAccountId: accounts.adjustmentGainId,
  });
  await supabase.from("teller_inventory_account_mappings").insert(
    mappings.map((row) => ({
      organization_id: orgId,
      mapping_key: row.mappingKey,
      account_id: row.accountId,
    })),
  );

  return {
    vendorId,
    vendorName,
    jobId: job.id as string,
    itemId: item.id as string,
    itemSku: item.sku as string,
    warehouseLocationId,
    truckLocationId,
    accounts,
    mappings,
  };
}

async function receiveInventoryGrni(
  ctx: RunCtx,
  input: {
    poQty: number;
    unitCost: number;
    receiptQty: number;
    idempotencyKey: string;
  },
) {
  assertMutationScope(ctx.orgId, ctx.orgId, "receiveInventoryGrni");
  const { purchaseOrderId } = await createPurchaseOrder(ctx.supabase, {
    organizationId: ctx.orgId,
    partyId: ctx.vendorId,
    jobId: ctx.jobId,
    issueDate: ENTRY_DATE,
    lines: [
      {
        description: "Inventory PO line",
        quantity: input.poQty,
        unitCost: input.unitCost,
        accountId: ctx.accounts.inventoryId,
        jobId: ctx.jobId,
      },
    ],
  });
  await submitPurchaseOrderForApproval(ctx.supabase, { organizationId: ctx.orgId, purchaseOrderId });
  await approvePurchaseOrder(ctx.supabase, { organizationId: ctx.orgId, purchaseOrderId });
  await markPurchaseOrderSent(ctx.supabase, { organizationId: ctx.orgId, purchaseOrderId });

  const { data: poLine } = await ctx.supabase
    .from("teller_purchase_order_lines")
    .select("id")
    .eq("purchase_order_id", purchaseOrderId)
    .single();
  if (!poLine?.id) throw new Error("PO line missing");

  const { receiptId } = await receivePurchaseOrder(ctx.supabase, {
    organizationId: ctx.orgId,
    purchaseOrderId,
    receiptDate: ENTRY_DATE,
    lines: [{ purchaseOrderLineId: poLine.id as string, quantityReceived: input.receiptQty }],
  });

  const { data: receiptLine } = await ctx.supabase
    .from("teller_purchase_receipt_lines")
    .select("id")
    .eq("receipt_id", receiptId)
    .single();
  if (!receiptLine?.id) throw new Error("Receipt line missing");

  const receiptLineId = receiptLine.id as string;
  const extendedCost = roundMoney(input.receiptQty * input.unitCost);

  await ctx.supabase
    .from("teller_purchase_receipt_lines")
    .update({
      inventory_item_id: ctx.itemId,
      inventory_location_id: ctx.warehouseLocationId,
      unit_cost: input.unitCost,
      extended_cost: extendedCost,
      idempotency_key: input.idempotencyKey,
      cost_source: "po_line_unit_cost",
    })
    .eq("id", receiptLineId);

  const receiptJournal = buildGrniReceiptJournalLines({
    amount: extendedCost,
    inventoryAssetAccountId: ctx.accounts.inventoryId,
    grniAccountId: ctx.accounts.grniId,
  });

  const received = await atomicReceiveInventory(ctx.supabase, {
    organizationId: ctx.orgId,
    inventoryItemId: ctx.itemId,
    locationId: ctx.warehouseLocationId,
    quantity: input.receiptQty,
    unitCost: input.unitCost,
    movementType: INVENTORY_MOVEMENT_TYPES.PURCHASE_RECEIPT,
    sourceType: "purchase_receipt_line",
    sourceId: receiptLineId,
    idempotencyKey: `movement:${input.idempotencyKey}`,
    entryDate: ENTRY_DATE,
    journalLines: toRpcJournalLines(receiptJournal),
    journalSourceKind: "inventory_movement",
    journalSourceId: receiptLineId,
  });

  await ctx.supabase
    .from("teller_purchase_receipt_lines")
    .update({
      accounting_status: "posted",
      inventory_movement_id: received.movementId,
      receipt_journal_entry_id: received.journalEntryId,
    })
    .eq("id", receiptLineId);

  return {
    receiptLineId,
    movementId: received.movementId,
    journalEntryId: received.journalEntryId!,
    poId: purchaseOrderId,
    extendedCost,
  };
}

async function createBillDraft(
  ctx: RunCtx,
  input: { amount: number; description: string; qty: number; unitCost: number },
) {
  assertMutationScope(ctx.orgId, ctx.orgId, "createBillDraft");
  const { data: existing } = await ctx.supabase
    .from("teller_documents")
    .select("number")
    .eq("organization_id", ctx.orgId)
    .eq("kind", "bill");
  const number = nextNumber("BILL", (existing ?? []).map((row) => row.number as string));
  const { data: doc, error } = await ctx.supabase
    .from("teller_documents")
    .insert({
      organization_id: ctx.orgId,
      kind: "bill",
      number,
      party_id: ctx.vendorId,
      job_id: ctx.jobId,
      status: "draft",
      issue_date: ENTRY_DATE,
      subtotal: input.amount,
      tax: 0,
      total: input.amount,
    })
    .select("id")
    .single();
  if (error || !doc) throw new Error(error?.message ?? "bill draft failed");

  const { data: line, error: lineError } = await ctx.supabase
    .from("teller_document_lines")
    .insert({
      document_id: doc.id,
      description: input.description,
      quantity: input.qty,
      unit_price: input.unitCost,
      amount: input.amount,
      account_id: ctx.accounts.inventoryId,
      item_type: "inventory",
    })
    .select("id")
    .single();
  if (lineError || !line) throw new Error(lineError?.message ?? "bill line failed");

  return { billId: doc.id as string, billLineId: line.id as string, number };
}

async function settleGrniBill(
  ctx: RunCtx,
  input: {
    receiptLineId: string;
    billLineId: string;
    billId: string;
    qty: number;
    receiptUnitCost: number;
    billUnitCost: number;
    idempotencyKey: string;
  },
) {
  assertMutationScope(ctx.orgId, ctx.orgId, "settleGrniBill");
  const grniAmount = roundMoney(input.qty * input.receiptUnitCost);
  const billAmount = roundMoney(input.qty * input.billUnitCost);
  const journalLines = buildGrniBillSettlementJournalLines({
    grniAmount,
    billAmount,
    grniAccountId: ctx.accounts.grniId,
    accountsPayableAccountId: ctx.accounts.apId,
    purchasePriceVarianceAccountId: ctx.accounts.ppvId,
  });
  const result = await atomicSettleInventoryReceiptBill(ctx.supabase, {
    organizationId: ctx.orgId,
    receiptLineId: input.receiptLineId,
    billLineId: input.billLineId,
    billId: input.billId,
    quantityMatched: input.qty,
    receiptUnitCost: input.receiptUnitCost,
    billUnitCost: input.billUnitCost,
    idempotencyKey: input.idempotencyKey,
    entryDate: ENTRY_DATE,
    journalLines: toRpcJournalLines(journalLines),
  });
  await ctx.supabase
    .from("teller_documents")
    .update({
      status: "open",
      posted_entry_id: result.journalEntryId,
    })
    .eq("id", input.billId);
  return { ...result, grniAmount, billAmount, varianceAmount: roundMoney(billAmount - grniAmount) };
}

async function issueInventoryAtWac(
  ctx: RunCtx,
  input: {
    quantity: number;
    movementType: string;
    idempotencyKey: string;
    jobId?: string | null;
    vendorId?: string | null;
    locationId?: string;
    journalLines?: InventoryJournalLine[];
  },
) {
  const locationId = input.locationId ?? ctx.warehouseLocationId;
  const row = await getBalanceRow(ctx.supabase, ctx.orgId, ctx.itemId, locationId);
  const wac = Number(row?.weighted_average_unit_cost ?? 0);
  const amount = roundMoney(input.quantity * wac);
  const journalLines =
    input.journalLines ??
    buildInventoryIssueJournalLines({
      amount,
      cogsAccountId: ctx.accounts.cogsId,
      inventoryAssetAccountId: ctx.accounts.inventoryId,
      jobId: input.jobId ?? undefined,
    });
  return atomicIssueInventory(ctx.supabase, {
    organizationId: ctx.orgId,
    inventoryItemId: ctx.itemId,
    locationId,
    quantity: input.quantity,
    movementType: input.movementType,
    idempotencyKey: input.idempotencyKey,
    jobId: input.jobId,
    vendorId: input.vendorId,
    entryDate: ENTRY_DATE,
    journalLines: toRpcJournalLines(journalLines),
    journalSourceKind: "inventory_movement",
  });
}

async function cogsGlActivity(supabase: SupabaseClient, orgId: string, cogsAccountId: string) {
  const { data: entries } = await supabase.from("teller_journal_entries").select("id").eq("organization_id", orgId);
  const ids = (entries ?? []).map((entry) => entry.id as string);
  if (!ids.length) return 0;
  const { data: lines } = await supabase
    .from("teller_journal_lines")
    .select("debit, credit")
    .in("entry_id", ids)
    .eq("account_id", cogsAccountId);
  return roundMoney((lines ?? []).reduce((sum, line) => sum + Number(line.debit ?? 0) - Number(line.credit ?? 0), 0));
}

async function loadReceiptStates(supabase: SupabaseClient, orgId: string): Promise<ReceiptOpenState[]> {
  const { data } = await supabase
    .from("teller_purchase_receipt_lines")
    .select("id, quantity_received, quantity_matched, extended_cost, value_matched, accounting_status")
    .eq("organization_id", orgId)
    .eq("accounting_status", "posted");
  return (data ?? []).map((row) => ({
    receiptLineId: row.id as string,
    quantityReceived: Number(row.quantity_received ?? 0),
    quantityMatched: Number(row.quantity_matched ?? 0),
    receiptValue: Number(row.extended_cost ?? 0),
    valueMatched: Number(row.value_matched ?? 0),
  }));
}

async function loadInventoryBalances(supabase: SupabaseClient, orgId: string) {
  const { data } = await supabase
    .from("teller_inventory_balances")
    .select("inventory_item_id, location_id, quantity_on_hand, inventory_value, weighted_average_unit_cost")
    .eq("organization_id", orgId);
  return (data ?? []).map((row) => ({
    inventoryItemId: row.inventory_item_id as string,
    locationId: row.location_id as string,
    quantityOnHand: Number(row.quantity_on_hand ?? 0),
    inventoryValue: Number(row.inventory_value ?? 0),
    weightedAverageUnitCost: Number(row.weighted_average_unit_cost ?? 0),
  }));
}

async function findOrphanInventoryMovements(supabase: SupabaseClient, orgId: string) {
  const { data: movements } = await supabase
    .from("teller_inventory_movements")
    .select("id, journal_entry_id, movement_type, reversed_by_movement_id")
    .eq("organization_id", orgId);
  return (movements ?? []).filter(
    (row) =>
      !row.reversed_by_movement_id &&
      ["purchase_receipt", "job_issue", "adjustment_in", "adjustment_out", "opening_balance"].includes(
        row.movement_type as string,
      ) &&
      !row.journal_entry_id,
  );
}

async function findOrphanInventoryJournals(supabase: SupabaseClient, orgId: string) {
  const { data: movements } = await supabase
    .from("teller_inventory_movements")
    .select("journal_entry_id")
    .eq("organization_id", orgId);
  const linked = new Set(
    (movements ?? []).map((row) => row.journal_entry_id).filter(Boolean) as string[],
  );
  const { data: receiptLines } = await supabase
    .from("teller_purchase_receipt_lines")
    .select("receipt_journal_entry_id")
    .eq("organization_id", orgId);
  for (const row of receiptLines ?? []) {
    if (row.receipt_journal_entry_id) linked.add(row.receipt_journal_entry_id as string);
  }
  const { data: allocations } = await supabase
    .from("teller_inventory_receipt_bill_allocations")
    .select("settlement_journal_entry_id, reversal_of_allocation_id")
    .eq("organization_id", orgId);
  for (const row of allocations ?? []) {
    if (row.reversal_of_allocation_id) continue;
    if (row.settlement_journal_entry_id) linked.add(row.settlement_journal_entry_id as string);
  }
  const { data: journals } = await supabase
    .from("teller_journal_entries")
    .select("id, source_kind, memo")
    .eq("organization_id", orgId)
    .in("source_kind", ["inventory_movement", "inventory_grni_settlement"]);
  return (journals ?? []).filter((row) => !linked.has(row.id as string));
}

async function findOrphanGrniSettlements(supabase: SupabaseClient, orgId: string) {
  const { data: allocations } = await supabase
    .from("teller_inventory_receipt_bill_allocations")
    .select("id, receipt_line_id, bill_line_id, reversed_by_allocation_id")
    .eq("organization_id", orgId);
  const { data: receiptLines } = await supabase
    .from("teller_purchase_receipt_lines")
    .select("id")
    .eq("organization_id", orgId);
  const { data: docs } = await supabase.from("teller_documents").select("id").eq("organization_id", orgId);
  const docIds = (docs ?? []).map((row) => row.id as string);
  let billLines: Array<{ id: string }> = [];
  if (docIds.length) {
    const { data } = await supabase.from("teller_document_lines").select("id").in("document_id", docIds);
    billLines = (data ?? []) as Array<{ id: string }>;
  }
  const receiptIds = new Set((receiptLines ?? []).map((row) => row.id));
  const billLineIds = new Set(billLines.map((row) => row.id));
  return (allocations ?? []).filter(
    (row) =>
      !row.reversed_by_allocation_id &&
      (!receiptIds.has(row.receipt_line_id as string) || !billLineIds.has(row.bill_line_id as string)),
  );
}

async function findBrokenTransferGroups(supabase: SupabaseClient, orgId: string) {
  const { data: groups } = await supabase
    .from("teller_inventory_transfer_groups")
    .select("id")
    .eq("organization_id", orgId);
  const broken: string[] = [];
  for (const group of groups ?? []) {
    const { count: outCount } = await ctxCountMovements(supabase, orgId, group.id as string, "transfer_out");
    const { count: inCount } = await ctxCountMovements(supabase, orgId, group.id as string, "transfer_in");
    if ((outCount ?? 0) !== 1 || (inCount ?? 0) !== 1) broken.push(group.id as string);
  }
  return broken;
}

async function ctxCountMovements(
  supabase: SupabaseClient,
  orgId: string,
  transferGroupId: string,
  movementType: string,
) {
  return supabase
    .from("teller_inventory_movements")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("transfer_group_id", transferGroupId)
    .eq("movement_type", movementType);
}

export async function runPhase13DbAcceptance() {
  const { orgId, foreignOrgId, phase11_1OrgId, supabase } = loadEnv();
  await assertOrgName(supabase, orgId, PHASE13_DEMO_ORG_NAME);
  await assertOrgName(supabase, foreignOrgId, CONTROLLED_PHASE13_FOREIGN_ORG_NAME);

  const peersBefore = await capturePeerFingerprints(supabase, 13);
  const phase11_1Before: OrgEconomicFingerprint = await captureOrgEconomicFingerprint(supabase, phase11_1OrgId);
  const hfacBefore = await hfacSnapshot(supabase);

  const byCode = await accountMap(supabase, orgId);
  const accounts = bundleAccounts(byCode);
  const results: Result[] = [];
  const flags: Flags = {};
  const failures: string[] = [];

  async function run(name: string, fn: () => Promise<void>, flagKey?: string) {
    try {
      await fn();
      results.push({ name, pass: true });
      if (flagKey) flags[flagKey] = true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ name, pass: false, detail });
      failures.push(`${name}: ${detail}`);
      if (flagKey) flags[flagKey] = false;
    }
  }

  if (!(await inventoryAtomicRpcAvailable(supabase))) {
    throw new Error(
      "Migration 031 atomic inventory RPCs are not callable. Apply supabase/migrations/031_phase13_inventory.sql, then re-run.",
    );
  }

  await clearPhase13Org(supabase, orgId);
  const base = await ensureBaseSetup(supabase, orgId, accounts);
  const ctx: RunCtx = { ...base, orgId, supabase };

  await run(
    "1 HFAC hard refusal",
    async () => {
      let threw = false;
      try {
        assertHfacInventoryHardRefusal(HFAC_ORG);
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("expected HFAC inventory refusal");
    },
    "HFAC_HARD_REFUSAL_PASS",
  );

  await run("2 HFAC zero Phase 13 inventory pre-test", async () => {
    const snap = await hfacSnapshot(supabase);
    if (snap.phase13_items !== 0 || snap.phase13_movements !== 0 || snap.phase13_grni_allocations !== 0) {
      throw new Error(`HFAC has phase13 rows: ${JSON.stringify(snap)}`);
    }
  });

  await run(
    "3 Receipt Dr Inventory Cr GRNI",
    async () => {
      const key = nextIdempotency("rcpt-grni");
      const { journalEntryId, extendedCost } = await receiveInventoryGrni(ctx, {
        poQty: 10,
        unitCost: 100,
        receiptQty: 10,
        idempotencyKey: key,
      });
      if (!(await journalBalanced(supabase, journalEntryId))) throw new Error("receipt journal unbalanced");
      const lines = await journalLines(supabase, journalEntryId);
      if (lineAmount(lines, accounts.inventoryId, "debit") !== extendedCost) throw new Error("inventory debit mismatch");
      if (lineAmount(lines, accounts.grniId, "credit") !== extendedCost) throw new Error("GRNI credit mismatch");
    },
    "RECEIPT_DR_INVENTORY_CR_GRNI_PASS",
  );

  await run(
    "4 Bill Dr GRNI Cr AP",
    async () => {
      const key = nextIdempotency("bill-grni");
      const rcpt = await receiveInventoryGrni(ctx, { poQty: 5, unitCost: 80, receiptQty: 5, idempotencyKey: key });
      const bill = await createBillDraft(ctx, { amount: 400, description: "Matched bill", qty: 5, unitCost: 80 });
      const settled = await settleGrniBill(ctx, {
        receiptLineId: rcpt.receiptLineId,
        billLineId: bill.billLineId,
        billId: bill.billId,
        qty: 5,
        receiptUnitCost: 80,
        billUnitCost: 80,
        idempotencyKey: grniSettlementIdempotencyKey(rcpt.receiptLineId, bill.billLineId, key),
      });
      if (!settled.journalEntryId) throw new Error("missing settlement journal");
      const lines = await journalLines(supabase, settled.journalEntryId);
      if (lineAmount(lines, accounts.grniId, "debit") !== 400) throw new Error("GRNI debit mismatch");
      if (lineAmount(lines, accounts.apId, "credit") !== 400) throw new Error("AP credit mismatch");
    },
    "BILL_DR_GRNI_CR_AP_PASS",
  );

  await run(
    "5 No duplicate inventory debit on bill settlement",
    async () => {
      const key = nextIdempotency("nodup");
      const rcpt = await receiveInventoryGrni(ctx, { poQty: 4, unitCost: 50, receiptQty: 4, idempotencyKey: key });
      const bill = await createBillDraft(ctx, { amount: 200, description: "No dup inv", qty: 4, unitCost: 50 });
      const settled = await settleGrniBill(ctx, {
        receiptLineId: rcpt.receiptLineId,
        billLineId: bill.billLineId,
        billId: bill.billId,
        qty: 4,
        receiptUnitCost: 50,
        billUnitCost: 50,
        idempotencyKey: grniSettlementIdempotencyKey(rcpt.receiptLineId, bill.billLineId, key),
      });
      const lines = await journalLines(supabase, settled.journalEntryId!);
      if (lineAmount(lines, accounts.inventoryId, "debit") > 0) {
        throw new Error("settlement journal debited inventory again");
      }
    },
    "NO_DUPLICATE_INVENTORY_ON_BILL_PASS",
  );

  await run(
    "6 Weighted average cost on second receipt",
    async () => {
      const fresh = await resetDemoOrg(supabase, orgId, accounts);
      Object.assign(ctx, fresh);
      await receiveInventoryGrni(ctx, { poQty: 10, unitCost: 100, receiptQty: 10, idempotencyKey: nextIdempotency("wac1") });
      await receiveInventoryGrni(ctx, { poQty: 10, unitCost: 120, receiptQty: 10, idempotencyKey: nextIdempotency("wac2") });
      const row = await getBalanceRow(supabase, orgId, ctx.itemId, ctx.warehouseLocationId);
      if (!row) throw new Error("balance row missing");
      if (Math.abs(Number(row.weighted_average_unit_cost) - 110) > 0.01) {
        throw new Error(`expected WAC 110, got ${row.weighted_average_unit_cost}`);
      }
    },
    "WEIGHTED_AVERAGE_COST_PASS",
  );

  await run(
    "7 Partial receipt leaves open GRNI",
    async () => {
      const key = nextIdempotency("partial-rcpt");
      const rcpt = await receiveInventoryGrni(ctx, { poQty: 20, unitCost: 25, receiptQty: 8, idempotencyKey: key });
      const { data: line } = await supabase
        .from("teller_purchase_receipt_lines")
        .select("quantity_received, quantity_matched, extended_cost, value_matched")
        .eq("id", rcpt.receiptLineId)
        .single();
      if (Number(line?.quantity_received) !== 8) throw new Error("partial receipt qty wrong");
      if (Number(line?.quantity_matched) !== 0) throw new Error("matched should be zero");
      const openValue = roundMoney(Number(line?.extended_cost ?? 0) - Number(line?.value_matched ?? 0));
      if (Math.abs(openValue - 200) > 0.02) throw new Error(`open receipt value ${openValue}, expected 200`);
    },
    "PARTIAL_RECEIPT_PASS",
  );

  await run(
    "8 Partial bill settlement",
    async () => {
      const key = nextIdempotency("partial-bill");
      const rcpt = await receiveInventoryGrni(ctx, { poQty: 10, unitCost: 30, receiptQty: 10, idempotencyKey: key });
      const bill = await createBillDraft(ctx, { amount: 90, description: "Partial bill", qty: 3, unitCost: 30 });
      await settleGrniBill(ctx, {
        receiptLineId: rcpt.receiptLineId,
        billLineId: bill.billLineId,
        billId: bill.billId,
        qty: 3,
        receiptUnitCost: 30,
        billUnitCost: 30,
        idempotencyKey: grniSettlementIdempotencyKey(rcpt.receiptLineId, bill.billLineId, key),
      });
      const { data: line } = await supabase
        .from("teller_purchase_receipt_lines")
        .select("quantity_matched")
        .eq("id", rcpt.receiptLineId)
        .single();
      if (Number(line?.quantity_matched) !== 3) throw new Error("partial match qty wrong");
    },
    "PARTIAL_BILL_PASS",
  );

  await run(
    "9 Many-to-many settlement",
    async () => {
      const key = nextIdempotency("m2m");
      const rcpt1 = await receiveInventoryGrni(ctx, { poQty: 10, unitCost: 10, receiptQty: 10, idempotencyKey: `${key}-r1` });
      const rcpt2 = await receiveInventoryGrni(ctx, { poQty: 10, unitCost: 10, receiptQty: 10, idempotencyKey: `${key}-r2` });
      const bill = await createBillDraft(ctx, { amount: 150, description: "Multi receipt bill", qty: 15, unitCost: 10 });
      await settleGrniBill(ctx, {
        receiptLineId: rcpt1.receiptLineId,
        billLineId: bill.billLineId,
        billId: bill.billId,
        qty: 10,
        receiptUnitCost: 10,
        billUnitCost: 10,
        idempotencyKey: grniSettlementIdempotencyKey(rcpt1.receiptLineId, bill.billLineId, `${key}-a`),
      });
      await settleGrniBill(ctx, {
        receiptLineId: rcpt2.receiptLineId,
        billLineId: bill.billLineId,
        billId: bill.billId,
        qty: 5,
        receiptUnitCost: 10,
        billUnitCost: 10,
        idempotencyKey: grniSettlementIdempotencyKey(rcpt2.receiptLineId, bill.billLineId, `${key}-b`),
      });
      const { count } = await supabase
        .from("teller_inventory_receipt_bill_allocations")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("bill_line_id", bill.billLineId);
      if ((count ?? 0) !== 2) throw new Error(`expected 2 allocations, got ${count}`);
    },
    "MANY_TO_MANY_MATCH_PASS",
  );

  await run(
    "10 Positive PPV",
    async () => {
      const key = nextIdempotency("ppv-pos");
      const rcpt = await receiveInventoryGrni(ctx, { poQty: 10, unitCost: 100, receiptQty: 10, idempotencyKey: key });
      const bill = await createBillDraft(ctx, { amount: 1050, description: "Higher bill", qty: 10, unitCost: 105 });
      const settled = await settleGrniBill(ctx, {
        receiptLineId: rcpt.receiptLineId,
        billLineId: bill.billLineId,
        billId: bill.billId,
        qty: 10,
        receiptUnitCost: 100,
        billUnitCost: 105,
        idempotencyKey: grniSettlementIdempotencyKey(rcpt.receiptLineId, bill.billLineId, key),
      });
      const lines = await journalLines(supabase, settled.journalEntryId!);
      if (lineAmount(lines, accounts.ppvId, "debit") !== 50) throw new Error("positive PPV debit expected");
    },
    "POSITIVE_PPV_PASS",
  );

  await run(
    "11 Negative PPV",
    async () => {
      const key = nextIdempotency("ppv-neg");
      const rcpt = await receiveInventoryGrni(ctx, { poQty: 10, unitCost: 100, receiptQty: 10, idempotencyKey: key });
      const bill = await createBillDraft(ctx, { amount: 950, description: "Lower bill", qty: 10, unitCost: 95 });
      const settled = await settleGrniBill(ctx, {
        receiptLineId: rcpt.receiptLineId,
        billLineId: bill.billLineId,
        billId: bill.billId,
        qty: 10,
        receiptUnitCost: 100,
        billUnitCost: 95,
        idempotencyKey: grniSettlementIdempotencyKey(rcpt.receiptLineId, bill.billLineId, key),
      });
      const lines = await journalLines(supabase, settled.journalEntryId!);
      if (lineAmount(lines, accounts.ppvId, "credit") !== 50) throw new Error("negative PPV credit expected");
    },
    "NEGATIVE_PPV_PASS",
  );

  await run(
    "12 PPV reconciliation totals",
    async () => {
      const { data: allocations } = await supabase
        .from("teller_inventory_receipt_bill_allocations")
        .select("variance_amount, reversed_by_allocation_id")
        .eq("organization_id", orgId);
      const ppvRows = buildPurchasePriceVarianceReport(
        (allocations ?? [])
          .filter((row) => !row.reversed_by_allocation_id && Math.abs(Number(row.variance_amount)) > 0.009)
          .map((row, index) => ({
            vendorId: ctx.vendorId,
            purchaseOrderId: "po",
            receiptLineId: `rl-${index}`,
            billLineId: `bl-${index}`,
            itemSku: ctx.itemSku,
            receiptUnitCost: 100,
            billUnitCost: 100,
            quantityMatched: 1,
            receiptValueMatched: 100,
            billValueMatched: 100 + Number(row.variance_amount),
            varianceAmount: Number(row.variance_amount),
          })),
      );
      const ppvGl = await glBalance(supabase, orgId, accounts.ppvId);
      const reportTotal = roundMoney(ppvRows.reduce((sum, row) => sum + row.variance, 0));
      if (Math.abs(reportTotal - ppvGl) > 0.05) {
        throw new Error(`PPV report ${reportTotal} vs GL ${ppvGl}`);
      }
    },
    "PPV_RECONCILIATION_PASS",
  );

  await run(
    "13 Consume inventory before bill settlement",
    async () => {
      const key = nextIdempotency("consume");
      const qtyBeforeIssue = Number(
        (await getBalanceRow(supabase, orgId, ctx.itemId, ctx.warehouseLocationId))?.quantity_on_hand ?? 0,
      );
      const rcpt = await receiveInventoryGrni(ctx, { poQty: 10, unitCost: 100, receiptQty: 10, idempotencyKey: key });
      const issued = await issueInventoryAtWac(ctx, {
        quantity: 4,
        movementType: INVENTORY_MOVEMENT_TYPES.JOB_ISSUE,
        idempotencyKey: `issue:${key}`,
        jobId: ctx.jobId,
      });
      if (!issued.journalEntryId) throw new Error("issue journal missing");
      const bill = await createBillDraft(ctx, { amount: 1000, description: "Bill after issue", qty: 10, unitCost: 100 });
      await settleGrniBill(ctx, {
        receiptLineId: rcpt.receiptLineId,
        billLineId: bill.billLineId,
        billId: bill.billId,
        qty: 10,
        receiptUnitCost: 100,
        billUnitCost: 100,
        idempotencyKey: grniSettlementIdempotencyKey(rcpt.receiptLineId, bill.billLineId, key),
      });
      const row = await getBalanceRow(supabase, orgId, ctx.itemId, ctx.warehouseLocationId);
      const expectedQty = qtyBeforeIssue + 10 - 4;
      if (Math.abs(Number(row?.quantity_on_hand) - expectedQty) > 0.01) {
        throw new Error(`qty should be ${expectedQty} after issue, got ${row?.quantity_on_hand}`);
      }
    },
    "CONSUME_BEFORE_BILL_PASS",
  );

  await run(
    "14 Phase 7 job material integration",
    async () => {
      const summary = await buildJobProfitabilitySummary(supabase, orgId, ctx.jobId);
      if (summary.inventoryMaterialCost <= 0) throw new Error("expected inventory material cost on job");
      if (summary.directMaterialCost !== summary.inventoryMaterialCost) {
        throw new Error("direct material should equal inventory material");
      }
    },
    "PHASE7_JOB_MATERIAL_INTEGRATION_PASS",
  );

  await run(
    "15 Job cost not duplicated by bill settlement",
    async () => {
      const before = await buildJobProfitabilitySummary(supabase, orgId, ctx.jobId);
      const key = nextIdempotency("nodup-job");
      const rcpt = await receiveInventoryGrni(ctx, { poQty: 5, unitCost: 40, receiptQty: 5, idempotencyKey: key });
      const bill = await createBillDraft(ctx, { amount: 200, description: "Job bill", qty: 5, unitCost: 40 });
      await settleGrniBill(ctx, {
        receiptLineId: rcpt.receiptLineId,
        billLineId: bill.billLineId,
        billId: bill.billId,
        qty: 5,
        receiptUnitCost: 40,
        billUnitCost: 40,
        idempotencyKey: grniSettlementIdempotencyKey(rcpt.receiptLineId, bill.billLineId, key),
      });
      const after = await buildJobProfitabilitySummary(supabase, orgId, ctx.jobId);
      if (Math.abs(after.inventoryMaterialCost - before.inventoryMaterialCost) > 0.01) {
        throw new Error("bill settlement changed job material cost");
      }
    },
    "JOB_COST_NOT_DUPLICATED_PASS",
  );

  await run(
    "16 Job material return",
    async () => {
      const fresh = await resetDemoOrg(supabase, orgId, accounts);
      Object.assign(ctx, fresh);
      const key = nextIdempotency("job-ret");
      await receiveInventoryGrni(ctx, { poQty: 10, unitCost: 50, receiptQty: 10, idempotencyKey: key });
      const issued = await issueInventoryAtWac(ctx, {
        quantity: 5,
        movementType: INVENTORY_MOVEMENT_TYPES.JOB_ISSUE,
        idempotencyKey: `issue:${key}`,
        jobId: ctx.jobId,
      });
      const returnAmount = roundMoney(2 * issued.unitCostApplied);
      const returnLines = reverseInventoryJournalLines(
        buildInventoryIssueJournalLines({
          amount: returnAmount,
          cogsAccountId: accounts.cogsId,
          inventoryAssetAccountId: accounts.inventoryId,
          jobId: ctx.jobId,
        }),
      );
      await atomicReceiveInventory(supabase, {
        organizationId: orgId,
        inventoryItemId: ctx.itemId,
        locationId: ctx.warehouseLocationId,
        quantity: 2,
        unitCost: issued.unitCostApplied,
        movementType: INVENTORY_MOVEMENT_TYPES.JOB_RETURN,
        sourceType: "job_return",
        sourceId: ctx.jobId,
        idempotencyKey: `return:${key}`,
        entryDate: ENTRY_DATE,
        journalLines: toRpcJournalLines(returnLines),
        journalSourceKind: "inventory_movement",
      });
      const row = await getBalanceRow(supabase, orgId, ctx.itemId, ctx.warehouseLocationId);
      if (Math.abs(Number(row?.quantity_on_hand) - 7) > 0.01) throw new Error(`expected qty 7 after return, got ${row?.quantity_on_hand}`);
    },
    "JOB_RETURN_PASS",
  );

  await run(
    "17 Warehouse to truck transfer",
    async () => {
      const fresh = await resetDemoOrg(supabase, orgId, accounts);
      Object.assign(ctx, fresh);
      const key = nextIdempotency("xfer");
      await receiveInventoryGrni(ctx, { poQty: 10, unitCost: 60, receiptQty: 10, idempotencyKey: key });
      const invBefore = await glBalance(supabase, orgId, accounts.inventoryId);
      const transferred = await atomicTransferInventory(supabase, {
        organizationId: orgId,
        inventoryItemId: ctx.itemId,
        fromLocationId: ctx.warehouseLocationId,
        toLocationId: ctx.truckLocationId,
        quantity: 4,
        idempotencyKey: key,
        occurredAt: `${ENTRY_DATE}T12:00:00Z`,
      });
      if (!transferred.outMovementId || !transferred.inMovementId) throw new Error("transfer legs missing");
      const wh = await getBalanceRow(supabase, orgId, ctx.itemId, ctx.warehouseLocationId);
      const truck = await getBalanceRow(supabase, orgId, ctx.itemId, ctx.truckLocationId);
      if (Math.abs(Number(wh?.quantity_on_hand) - 6) > 0.01 || Math.abs(Number(truck?.quantity_on_hand) - 4) > 0.01) {
        throw new Error(`transfer quantities wrong wh=${wh?.quantity_on_hand} truck=${truck?.quantity_on_hand}`);
      }
      const invAfter = await glBalance(supabase, orgId, accounts.inventoryId);
      if (Math.abs(invAfter - invBefore) > 0.02) throw new Error("transfer changed inventory GL");
    },
    "TRANSFER_PASS",
  );

  await run(
    "18 Unbilled vendor return Dr GRNI Cr Inventory",
    async () => {
      const key = nextIdempotency("unbilled-ret");
      await receiveInventoryGrni(ctx, { poQty: 10, unitCost: 20, receiptQty: 10, idempotencyKey: key });
      const grniBefore = await glBalance(supabase, orgId, accounts.grniId);
      const row = await getBalanceRow(supabase, orgId, ctx.itemId, ctx.warehouseLocationId);
      const wac = Number(row?.weighted_average_unit_cost ?? 20);
      const amount = roundMoney(2 * wac);
      const lines = buildUnbilledVendorReturnJournalLines({
        amount,
        grniAccountId: accounts.grniId,
        inventoryAssetAccountId: accounts.inventoryId,
      });
      await issueInventoryAtWac(ctx, {
        quantity: 2,
        movementType: INVENTORY_MOVEMENT_TYPES.VENDOR_RETURN,
        idempotencyKey: `vret:${key}`,
        vendorId: ctx.vendorId,
        journalLines: lines,
      });
      const grniAfter = await glBalance(supabase, orgId, accounts.grniId);
      if (grniAfter <= grniBefore) throw new Error("GRNI credit should decrease on unbilled return");
    },
    "UNBILLED_VENDOR_RETURN_PASS",
  );

  await run(
    "19 Billed vendor return after settlement",
    async () => {
      const key = nextIdempotency("billed-ret");
      const rcpt = await receiveInventoryGrni(ctx, { poQty: 5, unitCost: 100, receiptQty: 5, idempotencyKey: key });
      const bill = await createBillDraft(ctx, { amount: 500, description: "Return bill", qty: 5, unitCost: 100 });
      await settleGrniBill(ctx, {
        receiptLineId: rcpt.receiptLineId,
        billLineId: bill.billLineId,
        billId: bill.billId,
        qty: 5,
        receiptUnitCost: 100,
        billUnitCost: 100,
        idempotencyKey: grniSettlementIdempotencyKey(rcpt.receiptLineId, bill.billLineId, key),
      });
      const apBefore = await glBalance(supabase, orgId, accounts.apId);
      const wac = Number((await getBalanceRow(supabase, orgId, ctx.itemId, ctx.warehouseLocationId))?.weighted_average_unit_cost ?? 100);
      const returnLines = reverseInventoryJournalLines(
        buildGrniBillSettlementJournalLines({
          grniAmount: wac,
          billAmount: wac,
          grniAccountId: accounts.grniId,
          accountsPayableAccountId: accounts.apId,
          purchasePriceVarianceAccountId: accounts.ppvId,
        }),
      );
      await issueInventoryAtWac(ctx, {
        quantity: 1,
        movementType: INVENTORY_MOVEMENT_TYPES.VENDOR_RETURN,
        idempotencyKey: `billed-vret:${key}`,
        vendorId: ctx.vendorId,
        journalLines: returnLines,
      });
      const apAfter = await glBalance(supabase, orgId, accounts.apId);
      if (Math.abs(apAfter - apBefore) < 0.01) throw new Error("billed return should affect AP/inventory economics");
    },
    "BILLED_VENDOR_RETURN_PASS",
  );

  await run(
    "20 Price credit without physical return (negative PPV only)",
    async () => {
      const key = nextIdempotency("price-credit");
      const rcpt = await receiveInventoryGrni(ctx, { poQty: 10, unitCost: 100, receiptQty: 10, idempotencyKey: key });
      const qtyBefore = Number((await getBalanceRow(supabase, orgId, ctx.itemId, ctx.warehouseLocationId))?.quantity_on_hand ?? 0);
      const bill = await createBillDraft(ctx, { amount: 900, description: "Price credit bill", qty: 10, unitCost: 90 });
      await settleGrniBill(ctx, {
        receiptLineId: rcpt.receiptLineId,
        billLineId: bill.billLineId,
        billId: bill.billId,
        qty: 10,
        receiptUnitCost: 100,
        billUnitCost: 90,
        idempotencyKey: grniSettlementIdempotencyKey(rcpt.receiptLineId, bill.billLineId, key),
      });
      const qtyAfter = Number((await getBalanceRow(supabase, orgId, ctx.itemId, ctx.warehouseLocationId))?.quantity_on_hand ?? 0);
      if (qtyAfter !== qtyBefore) throw new Error("physical qty should not change on price credit");
      const ppvCredit = await glBalance(supabase, orgId, accounts.ppvId);
      if (ppvCredit >= 0) throw new Error("expected negative PPV (credit)");
    },
    "PRICE_CREDIT_NO_PHYSICAL_RETURN_PASS",
  );

  await run(
    "21 Unbilled receipt reversal",
    async () => {
      const key = nextIdempotency("rcpt-rev");
      const rcpt = await receiveInventoryGrni(ctx, { poQty: 5, unitCost: 100, receiptQty: 5, idempotencyKey: key });
      const reversalLines = reverseInventoryJournalLines(
        buildGrniReceiptJournalLines({
          amount: rcpt.extendedCost,
          inventoryAssetAccountId: accounts.inventoryId,
          grniAccountId: accounts.grniId,
        }),
      );
      const reversed = await atomicReverseInventoryMovement(supabase, {
        organizationId: orgId,
        movementId: rcpt.movementId,
        idempotencyKey: `rev:${key}`,
        entryDate: ENTRY_DATE,
        journalLines: toRpcJournalLines(reversalLines),
      });
      if (!reversed.journalEntryId) throw new Error("reversal journal missing");
      await supabase
        .from("teller_purchase_receipt_lines")
        .update({ accounting_status: "reversed" })
        .eq("id", rcpt.receiptLineId);
    },
    "RECEIPT_REVERSAL_PASS",
  );

  await run(
    "22 Matched receipt reversal guard",
    async () => {
      const key = nextIdempotency("matched-guard");
      const rcpt = await receiveInventoryGrni(ctx, { poQty: 5, unitCost: 50, receiptQty: 5, idempotencyKey: key });
      const bill = await createBillDraft(ctx, { amount: 250, description: "Guard bill", qty: 5, unitCost: 50 });
      await settleGrniBill(ctx, {
        receiptLineId: rcpt.receiptLineId,
        billLineId: bill.billLineId,
        billId: bill.billId,
        qty: 5,
        receiptUnitCost: 50,
        billUnitCost: 50,
        idempotencyKey: grniSettlementIdempotencyKey(rcpt.receiptLineId, bill.billLineId, key),
      });
      const { data: line } = await supabase
        .from("teller_purchase_receipt_lines")
        .select("quantity_matched")
        .eq("id", rcpt.receiptLineId)
        .single();
      const state: ReceiptOpenState = {
        receiptLineId: rcpt.receiptLineId,
        quantityReceived: 5,
        quantityMatched: Number(line?.quantity_matched ?? 0),
        receiptValue: 250,
        valueMatched: 250,
      };
      if (canReverseReceipt(state)) throw new Error("matched receipt should not be reversible");
    },
    "MATCHED_RECEIPT_REVERSAL_GUARD_PASS",
  );

  await run(
    "23 Settlement reversal",
    async () => {
      const key = nextIdempotency("settle-rev");
      const rcpt = await receiveInventoryGrni(ctx, { poQty: 4, unitCost: 75, receiptQty: 4, idempotencyKey: key });
      const bill = await createBillDraft(ctx, { amount: 300, description: "Reversal bill", qty: 4, unitCost: 75 });
      const settled = await settleGrniBill(ctx, {
        receiptLineId: rcpt.receiptLineId,
        billLineId: bill.billLineId,
        billId: bill.billId,
        qty: 4,
        receiptUnitCost: 75,
        billUnitCost: 75,
        idempotencyKey: grniSettlementIdempotencyKey(rcpt.receiptLineId, bill.billLineId, key),
      });
      const reversalLines = reverseInventoryJournalLines(
        buildGrniBillSettlementJournalLines({
          grniAmount: 300,
          billAmount: 300,
          grniAccountId: accounts.grniId,
          accountsPayableAccountId: accounts.apId,
          purchasePriceVarianceAccountId: accounts.ppvId,
        }),
      );
      await atomicReverseInventoryReceiptBillAllocation(supabase, {
        organizationId: orgId,
        allocationId: settled.allocationId,
        idempotencyKey: grniSettlementReversalIdempotencyKey(settled.allocationId),
        entryDate: ENTRY_DATE,
        journalLines: toRpcJournalLines(reversalLines),
      });
      const { data: line } = await supabase
        .from("teller_purchase_receipt_lines")
        .select("quantity_matched")
        .eq("id", rcpt.receiptLineId)
        .single();
      if (Number(line?.quantity_matched) !== 0) throw new Error("match qty should reset after reversal");
    },
    "SETTLEMENT_REVERSAL_PASS",
  );

  await run(
    "24 Negative inventory protection",
    async () => {
      const key = nextIdempotency("neg-inv");
      await receiveInventoryGrni(ctx, { poQty: 2, unitCost: 10, receiptQty: 2, idempotencyKey: key });
      const onHand = Number((await getBalanceRow(supabase, orgId, ctx.itemId, ctx.warehouseLocationId))?.quantity_on_hand ?? 0);
      let blocked = false;
      try {
        await issueInventoryAtWac(ctx, {
          quantity: onHand + 3,
          movementType: INVENTORY_MOVEMENT_TYPES.JOB_ISSUE,
          idempotencyKey: `neg:${key}`,
          jobId: ctx.jobId,
        });
      } catch (error) {
        if (error instanceof Error && /Insufficient inventory/i.test(error.message)) blocked = true;
      }
      if (!blocked) throw new Error("expected insufficient inventory rejection");
    },
    "NEGATIVE_INVENTORY_PROTECTION_PASS",
  );

  await run(
    "25 Inventory receipt concurrency idempotency",
    async () => {
      const key = nextIdempotency("conc-rcpt");
      const { purchaseOrderId } = await createPurchaseOrder(supabase, {
        organizationId: orgId,
        partyId: ctx.vendorId,
        jobId: ctx.jobId,
        issueDate: ENTRY_DATE,
        lines: [{ description: "Conc PO", quantity: 3, unitCost: 10, accountId: accounts.inventoryId }],
      });
      await submitPurchaseOrderForApproval(supabase, { organizationId: orgId, purchaseOrderId });
      await approvePurchaseOrder(supabase, { organizationId: orgId, purchaseOrderId });
      await markPurchaseOrderSent(supabase, { organizationId: orgId, purchaseOrderId });
      const { data: poLine } = await supabase
        .from("teller_purchase_order_lines")
        .select("id")
        .eq("purchase_order_id", purchaseOrderId)
        .single();
      const { receiptId } = await receivePurchaseOrder(supabase, {
        organizationId: orgId,
        purchaseOrderId,
        receiptDate: ENTRY_DATE,
        lines: [{ purchaseOrderLineId: poLine!.id as string, quantityReceived: 3 }],
      });
      const { data: receiptLine } = await supabase
        .from("teller_purchase_receipt_lines")
        .select("id")
        .eq("receipt_id", receiptId)
        .single();
      const receiptLineId = receiptLine!.id as string;
      await supabase
        .from("teller_purchase_receipt_lines")
        .update({
          inventory_item_id: ctx.itemId,
          inventory_location_id: ctx.warehouseLocationId,
          unit_cost: 10,
          extended_cost: 30,
          idempotency_key: key,
        })
        .eq("id", receiptLineId);
      const journal = buildGrniReceiptJournalLines({
        amount: 30,
        inventoryAssetAccountId: accounts.inventoryId,
        grniAccountId: accounts.grniId,
      });
      const payload = {
        organizationId: orgId,
        inventoryItemId: ctx.itemId,
        locationId: ctx.warehouseLocationId,
        quantity: 3,
        unitCost: 10,
        movementType: INVENTORY_MOVEMENT_TYPES.PURCHASE_RECEIPT,
        sourceType: "purchase_receipt_line",
        sourceId: receiptLineId,
        idempotencyKey: `movement:${key}`,
        entryDate: ENTRY_DATE,
        journalLines: toRpcJournalLines(journal),
      };
      const [a, b] = await Promise.all([
        atomicReceiveInventory(supabase, payload),
        atomicReceiveInventory(supabase, payload),
      ]);
      if (a.movementId !== b.movementId) throw new Error("concurrent receipt idempotency failed");
    },
    "INVENTORY_CONCURRENCY_PASS",
  );

  await run(
    "26 GRNI settlement concurrency idempotency",
    async () => {
      const key = nextIdempotency("conc-settle");
      const rcpt = await receiveInventoryGrni(ctx, { poQty: 3, unitCost: 10, receiptQty: 3, idempotencyKey: key });
      const bill = await createBillDraft(ctx, { amount: 30, description: "Conc settle", qty: 3, unitCost: 10 });
      const settleKey = grniSettlementIdempotencyKey(rcpt.receiptLineId, bill.billLineId, key);
      const lines = toRpcJournalLines(
        buildGrniBillSettlementJournalLines({
          grniAmount: 30,
          billAmount: 30,
          grniAccountId: accounts.grniId,
          accountsPayableAccountId: accounts.apId,
          purchasePriceVarianceAccountId: accounts.ppvId,
        }),
      );
      const payload = {
        organizationId: orgId,
        receiptLineId: rcpt.receiptLineId,
        billLineId: bill.billLineId,
        billId: bill.billId,
        quantityMatched: 3,
        receiptUnitCost: 10,
        billUnitCost: 10,
        idempotencyKey: settleKey,
        entryDate: ENTRY_DATE,
        journalLines: lines,
      };
      const [a, b] = await Promise.all([
        atomicSettleInventoryReceiptBill(supabase, payload),
        atomicSettleInventoryReceiptBill(supabase, payload),
      ]);
      if (a.allocationId !== b.allocationId) throw new Error("concurrent settlement idempotency failed");
    },
    "GRNI_SETTLEMENT_CONCURRENCY_PASS",
  );

  await run(
    "27 Duplicate receipt idempotency returns same movement",
    async () => {
      const key = nextIdempotency("idem-rcpt");
      const first = await receiveInventoryGrni(ctx, { poQty: 2, unitCost: 15, receiptQty: 2, idempotencyKey: key });
      const journal = buildGrniReceiptJournalLines({
        amount: 30,
        inventoryAssetAccountId: accounts.inventoryId,
        grniAccountId: accounts.grniId,
      });
      const dup = await atomicReceiveInventory(supabase, {
        organizationId: orgId,
        inventoryItemId: ctx.itemId,
        locationId: ctx.warehouseLocationId,
        quantity: 2,
        unitCost: 15,
        movementType: INVENTORY_MOVEMENT_TYPES.PURCHASE_RECEIPT,
        sourceType: "purchase_receipt_line",
        sourceId: first.receiptLineId,
        idempotencyKey: `movement:${key}`,
        entryDate: ENTRY_DATE,
        journalLines: toRpcJournalLines(journal),
      });
      if (!dup.duplicate || dup.movementId !== first.movementId) throw new Error("duplicate receipt not idempotent");
    },
    "IDEMPOTENCY_PASS",
  );

  await run(
    "28 Inventory quantity reconciliation bridge",
    async () => {
      const fresh = await resetDemoOrg(supabase, orgId, accounts);
      Object.assign(ctx, fresh);
      await receiveInventoryGrni(ctx, {
        poQty: 10,
        unitCost: 10,
        receiptQty: 10,
        idempotencyKey: nextIdempotency("recon-qty"),
      });
      await issueInventoryAtWac(ctx, {
        quantity: 3,
        movementType: INVENTORY_MOVEMENT_TYPES.JOB_ISSUE,
        idempotencyKey: nextIdempotency("recon-qty-issue"),
        jobId: ctx.jobId,
      });
      const balances = await loadInventoryBalances(supabase, orgId);
      const endingQty = balances.reduce((sum, row) => sum + row.quantityOnHand, 0);
      const { data: movements } = await supabase
        .from("teller_inventory_movements")
        .select("quantity_delta, movement_type, reversed_by_movement_id")
        .eq("organization_id", orgId);
      const active = (movements ?? []).filter((row) => !row.reversed_by_movement_id);
      const netDelta = active.reduce((sum, row) => sum + Number(row.quantity_delta ?? 0), 0);
      if (Math.abs(endingQty - netDelta) > 0.05) {
        throw new Error(`qty bridge mismatch ending=${endingQty} netDelta=${netDelta}`);
      }
    },
    "INVENTORY_QUANTITY_RECONCILIATION_PASS",
  );

  await run(
    "29 Inventory GL reconciliation",
    async () => {
      const fresh = await resetDemoOrg(supabase, orgId, accounts);
      Object.assign(ctx, fresh);
      await receiveInventoryGrni(ctx, {
        poQty: 8,
        unitCost: 25,
        receiptQty: 8,
        idempotencyKey: nextIdempotency("recon-inv-gl"),
      });
      const balances = await loadInventoryBalances(supabase, orgId);
      const glInv = await glBalance(supabase, orgId, accounts.inventoryId);
      const result = reconcileInventorySubledgerToGl({
        balances: balances.map((row) => ({
          quantityOnHand: row.quantityOnHand,
          inventoryValue: row.inventoryValue,
          weightedAverageUnitCost: row.weightedAverageUnitCost,
        })),
        glInventoryAssetBalance: glInv,
      });
      if (Math.abs(result.difference) > 0.05) {
        throw new Error(`inventory GL diff ${result.difference}`);
      }
    },
    "INVENTORY_GL_RECONCILIATION_PASS",
  );

  await run(
    "30 GRNI GL reconciliation",
    async () => {
      const fresh = await resetDemoOrg(supabase, orgId, accounts);
      Object.assign(ctx, fresh);
      const key = nextIdempotency("recon-grni");
      const rcpt = await receiveInventoryGrni(ctx, { poQty: 5, unitCost: 100, receiptQty: 5, idempotencyKey: key });
      const bill = await createBillDraft(ctx, { amount: 300, description: "Recon partial bill", qty: 3, unitCost: 100 });
      await settleGrniBill(ctx, {
        receiptLineId: rcpt.receiptLineId,
        billLineId: bill.billLineId,
        billId: bill.billId,
        qty: 3,
        receiptUnitCost: 100,
        billUnitCost: 100,
        idempotencyKey: grniSettlementIdempotencyKey(rcpt.receiptLineId, bill.billLineId, key),
      });
      const receipts = await loadReceiptStates(supabase, orgId);
      const grniGl = await glBalance(supabase, orgId, accounts.grniId);
      const result = reconcileGrniSubledgerToGl({ receipts, grniGlBalance: -grniGl });
      if (Math.abs(result.difference) > 0.05) {
        throw new Error(`GRNI GL diff ${result.difference} open=${result.openReceiptSubledger} gl=${grniGl}`);
      }
    },
    "GRNI_GL_RECONCILIATION_PASS",
  );

  await run(
    "31 COGS reconciliation",
    async () => {
      const fresh = await resetDemoOrg(supabase, orgId, accounts);
      Object.assign(ctx, fresh);
      const key = nextIdempotency("recon-cogs");
      await receiveInventoryGrni(ctx, { poQty: 10, unitCost: 20, receiptQty: 10, idempotencyKey: key });
      const issued = await issueInventoryAtWac(ctx, {
        quantity: 4,
        movementType: INVENTORY_MOVEMENT_TYPES.JOB_ISSUE,
        idempotencyKey: `recon-cogs-issue:${key}`,
        jobId: ctx.jobId,
      });
      const returnAmount = roundMoney(issued.unitCostApplied);
      await atomicReceiveInventory(supabase, {
        organizationId: orgId,
        inventoryItemId: ctx.itemId,
        locationId: ctx.warehouseLocationId,
        quantity: 1,
        unitCost: issued.unitCostApplied,
        movementType: INVENTORY_MOVEMENT_TYPES.JOB_RETURN,
        sourceType: "job_return",
        sourceId: ctx.jobId,
        idempotencyKey: `recon-cogs-return:${key}`,
        entryDate: ENTRY_DATE,
        journalLines: toRpcJournalLines(
          reverseInventoryJournalLines(
            buildInventoryIssueJournalLines({
              amount: returnAmount,
              cogsAccountId: accounts.cogsId,
              inventoryAssetAccountId: accounts.inventoryId,
              jobId: ctx.jobId,
            }),
          ),
        ),
        journalSourceKind: "inventory_movement",
      });
      const { data: movements } = await supabase
        .from("teller_inventory_movements")
        .select("extended_cost, movement_type, reversed_by_movement_id")
        .eq("organization_id", orgId)
        .in("movement_type", ["job_issue", "job_return"]);
      let materialCost = 0;
      for (const row of movements ?? []) {
        if (row.reversed_by_movement_id) continue;
        const cost = Number(row.extended_cost ?? 0);
        if (row.movement_type === "job_issue") materialCost += cost;
        if (row.movement_type === "job_return") materialCost -= cost;
      }
      const cogsGl = await cogsGlActivity(supabase, orgId, accounts.cogsId);
      const diff = reconcileInventoryCogs({ issueCosts: [roundMoney(materialCost)], cogsGlActivity: cogsGl });
      if (Math.abs(diff) > 0.05) throw new Error(`COGS diff ${diff}`);
    },
    "COGS_RECONCILIATION_PASS",
  );

  await run(
    "32 AP compatibility expense-only bill",
    async () => {
      const { data: existing } = await supabase.from("teller_documents").select("number").eq("organization_id", orgId).eq("kind", "bill");
      const number = nextNumber("EXP-BILL", (existing ?? []).map((row) => row.number as string));
      const { data: doc } = await supabase
        .from("teller_documents")
        .insert({
          organization_id: orgId,
          kind: "bill",
          number,
          party_id: ctx.vendorId,
          status: "draft",
          issue_date: ENTRY_DATE,
          subtotal: 150,
          tax: 0,
          total: 150,
        })
        .select("id")
        .single();
      await supabase.from("teller_document_lines").insert({
        document_id: doc!.id,
        description: "Non-inventory expense",
        quantity: 1,
        unit_price: 150,
        amount: 150,
        account_id: accounts.shrinkageId,
        item_type: "expense",
      });
      const invBefore = await glBalance(supabase, orgId, accounts.inventoryId);
      const apBefore = await glBalance(supabase, orgId, accounts.apId);
      await postBillOpen(supabase, {
        organizationId: orgId,
        documentId: doc!.id as string,
        partyId: ctx.vendorId,
        jobId: null,
        issueDate: ENTRY_DATE,
        number,
        tax: 0,
        lines: [{ amount: 150, account_id: accounts.shrinkageId, description: "Non-inventory expense" }],
      });
      const apAfter = await glBalance(supabase, orgId, accounts.apId);
      const invAfter = await glBalance(supabase, orgId, accounts.inventoryId);
      if (apAfter >= apBefore) throw new Error("AP liability should increase");
      if (Math.abs(invAfter - invBefore) > 0.01) throw new Error("expense bill should not touch inventory");
    },
    "AP_COMPATIBILITY_PASS",
  );

  await run(
    "33 Banking compatibility bill payment no inventory effect",
    async () => {
      assertPaymentDoesNotAffectInventory();
      const { data: bill } = await supabase
        .from("teller_documents")
        .select("id, number, total")
        .eq("organization_id", orgId)
        .eq("kind", "bill")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!bill?.id) throw new Error("no bill for payment test");
      const invBefore = await glBalance(supabase, orgId, accounts.inventoryId);
      const grniBefore = await glBalance(supabase, orgId, accounts.grniId);
      await postBillPaid(supabase, {
        organizationId: orgId,
        documentId: bill.id as string,
        partyId: ctx.vendorId,
        jobId: ctx.jobId,
        issueDate: ENTRY_DATE,
        number: bill.number as string,
        paymentAmount: Math.min(Number(bill.total), 50),
        billTotal: Number(bill.total),
      });
      const invAfter = await glBalance(supabase, orgId, accounts.inventoryId);
      const grniAfter = await glBalance(supabase, orgId, accounts.grniId);
      if (Math.abs(invAfter - invBefore) > 0.01 || Math.abs(grniAfter - grniBefore) > 0.01) {
        throw new Error("payment affected inventory or GRNI");
      }
    },
    "BANKING_COMPATIBILITY_PASS",
  );

  await run(
    "34 Opening inventory journal balanced",
    async () => {
      const lines = buildOpeningInventoryJournalLines({
        amount: 500,
        inventoryAssetAccountId: accounts.inventoryId,
        openingBalanceEquityAccountId: accounts.obeId,
      });
      if (lines.reduce((s, l) => s + l.debit, 0) !== lines.reduce((s, l) => s + l.credit, 0)) {
        throw new Error("opening lines unbalanced");
      }
    },
  );

  await run(
    "35 Adjustment increase/decrease journals balanced",
    async () => {
      const inc = buildInventoryIncreaseJournalLines({
        amount: 25,
        adjustmentGainAccountId: accounts.adjustmentGainId,
        inventoryAssetAccountId: accounts.inventoryId,
      });
      const dec = buildInventoryDecreaseJournalLines({
        amount: 25,
        adjustmentExpenseAccountId: accounts.shrinkageId,
        inventoryAssetAccountId: accounts.inventoryId,
      });
      const incBal = inc.reduce((s, l) => s + l.debit, 0) === inc.reduce((s, l) => s + l.credit, 0);
      const decBal = dec.reduce((s, l) => s + l.debit, 0) === dec.reduce((s, l) => s + l.credit, 0);
      if (!incBal || !decBal) throw new Error("adjustment journals unbalanced");
    },
  );

  await run(
    "36 Inventory valuation reporting",
    async () => {
      const { data: items } = await supabase
        .from("teller_inventory_items")
        .select("id, sku, name")
        .eq("organization_id", orgId);
      const balances = await loadInventoryBalances(supabase, orgId);
      const rows = buildInventoryValuationSummary(
        (items ?? []).map((row) => ({ id: row.id as string, sku: row.sku as string, name: row.name as string })),
        balances.map((row) => ({
          inventoryItemId: row.inventoryItemId,
          quantityOnHand: row.quantityOnHand,
          inventoryValue: row.inventoryValue,
          weightedAverageUnitCost: row.weightedAverageUnitCost,
        })),
      );
      if (!rows.length) throw new Error("valuation report empty");
      const pkg = buildAccountantInventoryPackage({
        valuation: rows,
        reconciliationDifference: 0,
        adjustments: [],
        movements: [{ id: "1" }],
      });
      if (pkg.valuation.length !== rows.length) throw new Error("accountant inventory package mismatch");
    },
    "INVENTORY_REPORTING_PASS",
  );

  await run(
    "37 GRNI aging report",
    async () => {
      const receipts = await loadReceiptStates(supabase, orgId);
      const aging = buildGrniAgingReport(
        receipts.map((row) => ({
          ...row,
          vendorId: ctx.vendorId,
          vendorName: ctx.vendorName,
          purchaseOrderId: "po",
          receiptDate: ENTRY_DATE,
          itemSku: ctx.itemSku,
        })),
        ENTRY_DATE,
      );
      if (!Array.isArray(aging)) throw new Error("aging report failed");
    },
    "GRNI_AGING_PASS",
  );

  await run(
    "38 PPV reporting",
    async () => {
      const { data: allocations } = await supabase
        .from("teller_inventory_receipt_bill_allocations")
        .select("*")
        .eq("organization_id", orgId);
      const rows = buildPurchasePriceVarianceReport(
        (allocations ?? []).map((row) => ({
          vendorId: ctx.vendorId,
          purchaseOrderId: "po",
          receiptLineId: row.receipt_line_id as string,
          billLineId: row.bill_line_id as string,
          itemSku: ctx.itemSku,
          receiptUnitCost: Number(row.receipt_value_matched) / Number(row.quantity_matched || 1),
          billUnitCost: Number(row.bill_value_matched) / Number(row.quantity_matched || 1),
          quantityMatched: Number(row.quantity_matched),
          receiptValueMatched: Number(row.receipt_value_matched),
          billValueMatched: Number(row.bill_value_matched),
          varianceAmount: Number(row.variance_amount),
          reversed: Boolean(row.reversed_by_allocation_id),
        })),
      );
      if (!Array.isArray(rows)) throw new Error("PPV report failed");
    },
    "PPV_REPORTING_PASS",
  );

  await run(
    "39 GRNI close integration findings",
    async () => {
      const receipts = await loadReceiptStates(supabase, orgId);
      const grniGl = await glBalance(supabase, orgId, accounts.grniId);
      const grniRecon = reconcileGrniSubledgerToGl({ receipts, grniGlBalance: grniGl });
      const aging = buildGrniAgingReport(
        receipts.map((row) => ({
          ...row,
          vendorId: ctx.vendorId,
          vendorName: ctx.vendorName,
          purchaseOrderId: "po",
          receiptDate: "2026-01-01",
          itemSku: ctx.itemSku,
        })),
        ENTRY_DATE,
      );
      const findings = evaluateGrniCloseFindings({
        grniDifference: grniRecon.difference,
        overCapacityCount: 0,
        brokenAllocationCount: 0,
        agingRows: aging,
        ppvTotal: await glBalance(supabase, orgId, accounts.ppvId),
      });
      if (!Array.isArray(findings)) throw new Error("close findings failed");
    },
    "CLOSE_INTEGRATION_PASS",
  );

  await run(
    "40 Accountant GRNI package",
    async () => {
      const receipts = await loadReceiptStates(supabase, orgId);
      const aging = buildGrniAgingReport(
        receipts.map((row) => ({
          ...row,
          vendorId: ctx.vendorId,
          vendorName: ctx.vendorName,
          purchaseOrderId: "po",
          receiptDate: ENTRY_DATE,
          itemSku: ctx.itemSku,
        })),
        ENTRY_DATE,
      );
      const pkg = buildAccountantGrniPackage({
        aging,
        ppvRows: [],
        reconciliationDifference: 0,
      });
      if (pkg.openGrniTotal !== roundMoney(sumOpenGrniSubledger(receipts))) {
        throw new Error("accountant package open GRNI mismatch");
      }
    },
    "ACCOUNTANT_PACKAGE_PASS",
  );

  await run(
    "41 Foreign org cannot read demo inventory movement",
    async () => {
      const key = nextIdempotency("tenant");
      const rcpt = await receiveInventoryGrni(ctx, { poQty: 1, unitCost: 10, receiptQty: 1, idempotencyKey: key });
      const { data: scoped } = await supabase
        .from("teller_inventory_movements")
        .select("id")
        .eq("organization_id", foreignOrgId)
        .eq("id", rcpt.movementId)
        .maybeSingle();
      if (scoped) throw new Error("foreign org query returned demo movement");
      try {
        assertMutationScope(foreignOrgId, orgId, "foreign write attempt");
        throw new Error("mutation scope should refuse foreign org");
      } catch (error) {
        if (!(error instanceof Error) || !/Refusing foreign write attempt|outside active phase demo org/.test(error.message)) {
          throw error;
        }
      }
    },
    "TENANT_ISOLATION_PASS",
  );

  await run("42 Required inventory account mappings present", async () => {
    const { data: rows } = await supabase
      .from("teller_inventory_account_mappings")
      .select("mapping_key, account_id")
      .eq("organization_id", orgId);
    const mapped = buildDefaultInventoryAccountMappings({
      inventoryAssetAccountId: accounts.inventoryId,
      grniAccountId: accounts.grniId,
      ppvAccountId: accounts.ppvId,
      cogsAccountId: accounts.cogsId,
      adjustmentExpenseAccountId: accounts.shrinkageId,
      adjustmentGainAccountId: accounts.adjustmentGainId,
    });
    for (const key of Object.values(INVENTORY_ACCOUNT_MAPPING_KEYS)) {
      const found = (rows ?? []).some((row) => row.mapping_key === key);
      if (!found && !mapped.some((row) => row.mappingKey === key)) {
        throw new Error(`missing mapping ${key}`);
      }
    }
  });

  await run("43 Preview bill settlement math", async () => {
    const preview = previewBillSettlement({
      receiptLineId: "rl",
      billLineId: "bl",
      quantityToMatch: 5,
      receiptUnitCost: 100,
      billUnitCost: 105,
    });
    if (preview.varianceAmount !== 25) throw new Error(`preview variance ${preview.varianceAmount}`);
  });

  await run("44 Opening balance receive via RPC", async () => {
    const key = nextIdempotency("opening");
    const lines = buildOpeningInventoryJournalLines({
      amount: 300,
      inventoryAssetAccountId: accounts.inventoryId,
      openingBalanceEquityAccountId: accounts.obeId,
    });
    await atomicReceiveInventory(supabase, {
      organizationId: orgId,
      inventoryItemId: ctx.itemId,
      locationId: ctx.truckLocationId,
      quantity: 3,
      unitCost: 100,
      movementType: INVENTORY_MOVEMENT_TYPES.OPENING_BALANCE,
      sourceType: "opening_balance",
      sourceId: randomUUID(),
      idempotencyKey: key,
      entryDate: ENTRY_DATE,
      journalLines: toRpcJournalLines(lines),
    });
  });

  await run("45 Adjustment increase posts to inventory", async () => {
    const key = nextIdempotency("adj-inc");
    const lines = buildInventoryIncreaseJournalLines({
      amount: 40,
      adjustmentGainAccountId: accounts.adjustmentGainId,
      inventoryAssetAccountId: accounts.inventoryId,
    });
    await atomicReceiveInventory(supabase, {
      organizationId: orgId,
      inventoryItemId: ctx.itemId,
      locationId: ctx.warehouseLocationId,
      quantity: 1,
      unitCost: 40,
      movementType: INVENTORY_MOVEMENT_TYPES.ADJUSTMENT_IN,
      sourceType: "adjustment",
      sourceId: randomUUID(),
      idempotencyKey: key,
      entryDate: ENTRY_DATE,
      journalLines: toRpcJournalLines(lines),
    });
  });

  await run("46 Adjustment decrease posts shrinkage", async () => {
    const key = nextIdempotency("adj-dec");
    const lines = buildInventoryDecreaseJournalLines({
      amount: 20,
      adjustmentExpenseAccountId: accounts.shrinkageId,
      inventoryAssetAccountId: accounts.inventoryId,
    });
    await atomicIssueInventory(supabase, {
      organizationId: orgId,
      inventoryItemId: ctx.itemId,
      locationId: ctx.warehouseLocationId,
      quantity: 1,
      movementType: INVENTORY_MOVEMENT_TYPES.ADJUSTMENT_OUT,
      idempotencyKey: key,
      entryDate: ENTRY_DATE,
      journalLines: toRpcJournalLines(lines),
      issueUnitCost: 20,
    });
  });

  await run("47 Transfer insufficient stock rejected", async () => {
    let blocked = false;
    try {
      await atomicTransferInventory(supabase, {
        organizationId: orgId,
        inventoryItemId: ctx.itemId,
        fromLocationId: ctx.truckLocationId,
        toLocationId: ctx.warehouseLocationId,
        quantity: 99999,
        idempotencyKey: nextIdempotency("xfer-fail"),
      });
    } catch (error) {
      if (error instanceof Error && /Insufficient inventory/i.test(error.message)) blocked = true;
    }
    if (!blocked) throw new Error("expected transfer insufficient stock rejection");
  });

  await run("48 Settlement over-capacity rejected", async () => {
    const key = nextIdempotency("overcap");
    const rcpt = await receiveInventoryGrni(ctx, { poQty: 2, unitCost: 10, receiptQty: 2, idempotencyKey: key });
    const bill = await createBillDraft(ctx, { amount: 100, description: "Over cap", qty: 10, unitCost: 10 });
    let blocked = false;
    try {
      await settleGrniBill(ctx, {
        receiptLineId: rcpt.receiptLineId,
        billLineId: bill.billLineId,
        billId: bill.billId,
        qty: 10,
        receiptUnitCost: 10,
        billUnitCost: 10,
        idempotencyKey: grniSettlementIdempotencyKey(rcpt.receiptLineId, bill.billLineId, key),
      });
    } catch (error) {
      if (error instanceof Error && /exceeds open receipt quantity/i.test(error.message)) blocked = true;
    }
    if (!blocked) throw new Error("expected over-capacity settlement rejection");
  });

  await run("49 Receipt line posted status after GRNI receive", async () => {
    const key = nextIdempotency("posted-status");
    const rcpt = await receiveInventoryGrni(ctx, { poQty: 1, unitCost: 5, receiptQty: 1, idempotencyKey: key });
    const { data: line } = await supabase
      .from("teller_purchase_receipt_lines")
      .select("accounting_status, inventory_movement_id, receipt_journal_entry_id")
      .eq("id", rcpt.receiptLineId)
      .single();
    if (line?.accounting_status !== "posted") throw new Error("receipt line not posted");
    if (!line.inventory_movement_id || !line.receipt_journal_entry_id) throw new Error("missing lineage ids");
  });

  await run("50 Duplicate settlement reversal blocked", async () => {
    const key = nextIdempotency("dup-rev");
    const rcpt = await receiveInventoryGrni(ctx, { poQty: 2, unitCost: 10, receiptQty: 2, idempotencyKey: key });
    const bill = await createBillDraft(ctx, { amount: 20, description: "Dup rev", qty: 2, unitCost: 10 });
    const settled = await settleGrniBill(ctx, {
      receiptLineId: rcpt.receiptLineId,
      billLineId: bill.billLineId,
      billId: bill.billId,
      qty: 2,
      receiptUnitCost: 10,
      billUnitCost: 10,
      idempotencyKey: grniSettlementIdempotencyKey(rcpt.receiptLineId, bill.billLineId, key),
    });
    const reversalLines = reverseInventoryJournalLines(
      buildGrniBillSettlementJournalLines({
        grniAmount: 20,
        billAmount: 20,
        grniAccountId: accounts.grniId,
        accountsPayableAccountId: accounts.apId,
        purchasePriceVarianceAccountId: accounts.ppvId,
      }),
    );
    const revKey = grniSettlementReversalIdempotencyKey(settled.allocationId);
    await atomicReverseInventoryReceiptBillAllocation(supabase, {
      organizationId: orgId,
      allocationId: settled.allocationId,
      idempotencyKey: revKey,
      entryDate: ENTRY_DATE,
      journalLines: toRpcJournalLines(reversalLines),
    });
    const dup = await atomicReverseInventoryReceiptBillAllocation(supabase, {
      organizationId: orgId,
      allocationId: settled.allocationId,
      idempotencyKey: revKey,
      entryDate: ENTRY_DATE,
      journalLines: toRpcJournalLines(reversalLines),
    });
    if (!dup.duplicate) throw new Error("duplicate settlement reversal should be idempotent");
  });

  await run("51 Job profitability summary returns expected shape", async () => {
    const summary = await buildJobProfitabilitySummary(supabase, orgId, ctx.jobId);
    if (!summary.jobId || summary.actualDirectCost < 0) throw new Error("invalid profitability summary");
  });

  await run("52 GRNI open subledger sum", async () => {
    const receipts = await loadReceiptStates(supabase, orgId);
    const open = sumOpenGrniSubledger(receipts);
    if (open < 0) throw new Error("negative open GRNI subledger");
  });

  await run("53 canReverseReceipt true when unmatched", async () => {
    const key = nextIdempotency("can-rev");
    const rcpt = await receiveInventoryGrni(ctx, { poQty: 1, unitCost: 1, receiptQty: 1, idempotencyKey: key });
    const state: ReceiptOpenState = {
      receiptLineId: rcpt.receiptLineId,
      quantityReceived: 1,
      quantityMatched: 0,
      receiptValue: rcpt.extendedCost,
      valueMatched: 0,
    };
    if (!canReverseReceipt(state)) throw new Error("unmatched receipt should be reversible");
  });

  await run("54 Issue journal Dr COGS Cr Inventory", async () => {
    const key = nextIdempotency("issue-jnl");
    await receiveInventoryGrni(ctx, { poQty: 3, unitCost: 10, receiptQty: 3, idempotencyKey: key });
    const issued = await issueInventoryAtWac(ctx, {
      quantity: 1,
      movementType: INVENTORY_MOVEMENT_TYPES.JOB_ISSUE,
      idempotencyKey: `issue-jnl:${key}`,
      jobId: ctx.jobId,
    });
    const posted = await journalLines(supabase, issued.journalEntryId!);
    if (lineAmount(posted, accounts.cogsId, "debit") <= 0) throw new Error("COGS debit missing");
  });

  await run("55 Zero PPV settlement has no PPV line activity", async () => {
    const key = nextIdempotency("zero-ppv");
    const rcpt = await receiveInventoryGrni(ctx, { poQty: 2, unitCost: 50, receiptQty: 2, idempotencyKey: key });
    const bill = await createBillDraft(ctx, { amount: 100, description: "Zero ppv", qty: 2, unitCost: 50 });
    const settled = await settleGrniBill(ctx, {
      receiptLineId: rcpt.receiptLineId,
      billLineId: bill.billLineId,
      billId: bill.billId,
      qty: 2,
      receiptUnitCost: 50,
      billUnitCost: 50,
      idempotencyKey: grniSettlementIdempotencyKey(rcpt.receiptLineId, bill.billLineId, key),
    });
    if (Math.abs(settled.varianceAmount) > 0.009) throw new Error("expected zero variance");
  });

  await run("56 Multiple partial settlements accumulate matched qty", async () => {
    const key = nextIdempotency("multi-partial");
    const rcpt = await receiveInventoryGrni(ctx, { poQty: 10, unitCost: 10, receiptQty: 10, idempotencyKey: key });
    const bill1 = await createBillDraft(ctx, { amount: 30, description: "Partial 1", qty: 3, unitCost: 10 });
    const bill2 = await createBillDraft(ctx, { amount: 20, description: "Partial 2", qty: 2, unitCost: 10 });
    await settleGrniBill(ctx, {
      receiptLineId: rcpt.receiptLineId,
      billLineId: bill1.billLineId,
      billId: bill1.billId,
      qty: 3,
      receiptUnitCost: 10,
      billUnitCost: 10,
      idempotencyKey: grniSettlementIdempotencyKey(rcpt.receiptLineId, bill1.billLineId, `${key}-1`),
    });
    await settleGrniBill(ctx, {
      receiptLineId: rcpt.receiptLineId,
      billLineId: bill2.billLineId,
      billId: bill2.billId,
      qty: 2,
      receiptUnitCost: 10,
      billUnitCost: 10,
      idempotencyKey: grniSettlementIdempotencyKey(rcpt.receiptLineId, bill2.billLineId, `${key}-2`),
    });
    const { data: line } = await supabase
      .from("teller_purchase_receipt_lines")
      .select("quantity_matched")
      .eq("id", rcpt.receiptLineId)
      .single();
    if (Number(line?.quantity_matched) !== 5) throw new Error("accumulated matched qty wrong");
  });

  await run("57 All posted inventory journals balanced", async () => {
    const { data: entries } = await supabase
      .from("teller_journal_entries")
      .select("id")
      .eq("organization_id", orgId);
    for (const entry of entries ?? []) {
      if (!(await journalBalanced(supabase, entry.id as string))) {
        throw new Error(`unbalanced journal ${entry.id}`);
      }
    }
  });

  await run("58 Service role reads demo org movement with correct org_id", async () => {
    const { data: movement } = await supabase
      .from("teller_inventory_movements")
      .select("organization_id")
      .eq("organization_id", orgId)
      .limit(1)
      .maybeSingle();
    if (!movement) throw new Error("no movements to verify");
    if (movement.organization_id !== orgId) throw new Error("movement org_id mismatch");
  });

  await run("59 Receipt uses PO line unit cost source", async () => {
    const key = nextIdempotency("cost-src");
    const rcpt = await receiveInventoryGrni(ctx, { poQty: 2, unitCost: 33.33, receiptQty: 2, idempotencyKey: key });
    const { data: line } = await supabase
      .from("teller_purchase_receipt_lines")
      .select("unit_cost, cost_source, extended_cost")
      .eq("id", rcpt.receiptLineId)
      .single();
    if (line?.cost_source !== "po_line_unit_cost") throw new Error("cost source mismatch");
    if (Math.abs(Number(line.extended_cost) - 66.66) > 0.02) throw new Error("extended cost mismatch");
  });

  await run("60 Movement idempotency key uniqueness per org", async () => {
    const { data: movements } = await supabase
      .from("teller_inventory_movements")
      .select("idempotency_key")
      .eq("organization_id", orgId);
    const keys = (movements ?? []).map((row) => row.idempotency_key as string);
    if (new Set(keys).size !== keys.length) throw new Error("duplicate movement idempotency keys in org");
  });

  // Orphan scan on clean org after isolated receipt (proves integrity baseline)
  const orphanScanBase = await resetDemoOrg(supabase, orgId, accounts);
  Object.assign(ctx, orphanScanBase);
  await receiveInventoryGrni(ctx, {
    poQty: 1,
    unitCost: 10,
    receiptQty: 1,
    idempotencyKey: nextIdempotency("orphan-scan"),
  });
  const orphanMovements = await findOrphanInventoryMovements(supabase, orgId);
  const orphanJournals = await findOrphanInventoryJournals(supabase, orgId);
  const orphanSettlements = await findOrphanGrniSettlements(supabase, orgId);
  const brokenTransfers = await findBrokenTransferGroups(supabase, orgId);
  flags.ORPHAN_INVENTORY_MOVEMENTS = orphanMovements.length;
  flags.ORPHAN_INVENTORY_JOURNALS = orphanJournals.length;
  flags.ORPHAN_GRNI_SETTLEMENTS = orphanSettlements.length;
  flags.BROKEN_TRANSFER_GROUPS = brokenTransfers.length;

  results.push({
    name: "61 Orphan inventory movements scan",
    pass: orphanMovements.length === 0,
    detail: orphanMovements.length ? `${orphanMovements.length} orphan movement(s)` : undefined,
  });
  results.push({
    name: "62 Orphan inventory journals scan",
    pass: orphanJournals.length === 0,
    detail: orphanJournals.length ? `${orphanJournals.length} orphan journal(s)` : undefined,
  });
  results.push({
    name: "63 Orphan GRNI settlements scan",
    pass: orphanSettlements.length === 0,
    detail: orphanSettlements.length ? `${orphanSettlements.length} orphan settlement(s)` : undefined,
  });
  results.push({
    name: "64 Broken transfer groups scan",
    pass: brokenTransfers.length === 0,
    detail: brokenTransfers.length ? `${brokenTransfers.length} broken group(s)` : undefined,
  });

  const phase11_1After = await captureOrgEconomicFingerprint(supabase, phase11_1OrgId);
  flags.PHASE11_1_COMPATIBILITY_PASS = JSON.stringify(phase11_1After) === JSON.stringify(phase11_1Before);
  results.push({
    name: "65 Phase 11.1 demo org fingerprint unchanged",
    pass: flags.PHASE11_1_COMPATIBILITY_PASS === true,
    detail:
      flags.PHASE11_1_COMPATIBILITY_PASS === true
        ? undefined
        : `before=${JSON.stringify(phase11_1Before)} after=${JSON.stringify(phase11_1After)}`,
  });

  try {
    await assertPeerFingerprintsUnchanged(supabase, peersBefore, 13);
    results.push({ name: "66 Peer org fingerprints unchanged", pass: true });
  } catch (error) {
    results.push({
      name: "66 Peer org fingerprints unchanged",
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const hfacAfter = await hfacSnapshot(supabase);
  flags.HFAC_BASELINE_UNCHANGED =
    hfacBefore.documents === hfacAfter.documents &&
    hfacBefore.payments === hfacAfter.payments &&
    hfacBefore.journals === hfacAfter.journals &&
    hfacAfter.phase13_items === 0 &&
    hfacAfter.phase13_movements === 0 &&
    hfacAfter.phase13_grni_allocations === 0;

  results.push({
    name: "67 HFAC baseline unchanged post-test",
    pass: flags.HFAC_BASELINE_UNCHANGED === true,
    detail:
      flags.HFAC_BASELINE_UNCHANGED === true
        ? undefined
        : `before=${JSON.stringify(hfacBefore)} after=${JSON.stringify(hfacAfter)}`,
  });

  await run("68 assertMutationScope refuses HFAC org", async () => {
    try {
      assertMutationScope(HFAC_ORG, orgId, "hfac write");
      throw new Error("should refuse HFAC");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (!/HFAC|outside active phase demo org/i.test(error.message)) throw error;
    }
  });

  await run("69 GRNI receipt journal reverseInventoryJournalLines balanced", async () => {
    const reversed = reverseInventoryJournalLines(
      buildGrniReceiptJournalLines({
        amount: 100,
        inventoryAssetAccountId: accounts.inventoryId,
        grniAccountId: accounts.grniId,
      }),
    );
    const d = reversed.reduce((s, l) => s + l.debit, 0);
    const c = reversed.reduce((s, l) => s + l.credit, 0);
    if (Math.abs(d - c) > 0.009) throw new Error("reversed receipt lines unbalanced");
  });

  await run("70 Inventory mappings keys cover required set", async () => {
    const required = Object.values(INVENTORY_ACCOUNT_MAPPING_KEYS);
    if (required.length < 6) throw new Error("mapping keys incomplete");
  });

  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;

  flags.PHASE13_DB_ACCEPTANCE_SCENARIOS = results.length;
  flags.PHASE13_DB_ACCEPTANCE = fail === 0 ? "PASS" : "FAIL";
  flags.PHASE13_FAILURES = failures.length;

  return {
    pass,
    fail,
    total: results.length,
    results,
    flags,
    failures,
    hfacBefore,
    hfacAfter,
    hfacUnchanged: flags.HFAC_BASELINE_UNCHANGED === true,
    phase11_1Unchanged: flags.PHASE11_1_COMPATIBILITY_PASS === true,
  };
}

function isMainModule() {
  const entry = process.argv[1];
  return entry?.endsWith("controlled-phase13-db-acceptance.ts") || entry === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  runPhase13DbAcceptance()
    .then((summary) => {
      console.log(`Phase 13 DB acceptance: ${summary.pass}/${summary.total} passed`);
      console.log(
        JSON.stringify(
          {
            PHASE13_DB_ACCEPTANCE: summary.flags.PHASE13_DB_ACCEPTANCE,
            PHASE13_DB_ACCEPTANCE_SCENARIOS: summary.flags.PHASE13_DB_ACCEPTANCE_SCENARIOS,
            RECEIPT_DR_INVENTORY_CR_GRNI_PASS: summary.flags.RECEIPT_DR_INVENTORY_CR_GRNI_PASS === true,
            BILL_DR_GRNI_CR_AP_PASS: summary.flags.BILL_DR_GRNI_CR_AP_PASS === true,
            NO_DUPLICATE_INVENTORY_ON_BILL_PASS: summary.flags.NO_DUPLICATE_INVENTORY_ON_BILL_PASS === true,
            WEIGHTED_AVERAGE_COST_PASS: summary.flags.WEIGHTED_AVERAGE_COST_PASS === true,
            PARTIAL_RECEIPT_PASS: summary.flags.PARTIAL_RECEIPT_PASS === true,
            PARTIAL_BILL_PASS: summary.flags.PARTIAL_BILL_PASS === true,
            MANY_TO_MANY_MATCH_PASS: summary.flags.MANY_TO_MANY_MATCH_PASS === true,
            POSITIVE_PPV_PASS: summary.flags.POSITIVE_PPV_PASS === true,
            NEGATIVE_PPV_PASS: summary.flags.NEGATIVE_PPV_PASS === true,
            PPV_RECONCILIATION_PASS: summary.flags.PPV_RECONCILIATION_PASS === true,
            CONSUME_BEFORE_BILL_PASS: summary.flags.CONSUME_BEFORE_BILL_PASS === true,
            PHASE7_JOB_MATERIAL_INTEGRATION_PASS: summary.flags.PHASE7_JOB_MATERIAL_INTEGRATION_PASS === true,
            JOB_COST_NOT_DUPLICATED_PASS: summary.flags.JOB_COST_NOT_DUPLICATED_PASS === true,
            JOB_RETURN_PASS: summary.flags.JOB_RETURN_PASS === true,
            TRANSFER_PASS: summary.flags.TRANSFER_PASS === true,
            UNBILLED_VENDOR_RETURN_PASS: summary.flags.UNBILLED_VENDOR_RETURN_PASS === true,
            BILLED_VENDOR_RETURN_PASS: summary.flags.BILLED_VENDOR_RETURN_PASS === true,
            PRICE_CREDIT_NO_PHYSICAL_RETURN_PASS: summary.flags.PRICE_CREDIT_NO_PHYSICAL_RETURN_PASS === true,
            RECEIPT_REVERSAL_PASS: summary.flags.RECEIPT_REVERSAL_PASS === true,
            MATCHED_RECEIPT_REVERSAL_GUARD_PASS: summary.flags.MATCHED_RECEIPT_REVERSAL_GUARD_PASS === true,
            SETTLEMENT_REVERSAL_PASS: summary.flags.SETTLEMENT_REVERSAL_PASS === true,
            NEGATIVE_INVENTORY_PROTECTION_PASS: summary.flags.NEGATIVE_INVENTORY_PROTECTION_PASS === true,
            INVENTORY_CONCURRENCY_PASS: summary.flags.INVENTORY_CONCURRENCY_PASS === true,
            GRNI_SETTLEMENT_CONCURRENCY_PASS: summary.flags.GRNI_SETTLEMENT_CONCURRENCY_PASS === true,
            IDEMPOTENCY_PASS: summary.flags.IDEMPOTENCY_PASS === true,
            INVENTORY_QUANTITY_RECONCILIATION_PASS: summary.flags.INVENTORY_QUANTITY_RECONCILIATION_PASS === true,
            INVENTORY_GL_RECONCILIATION_PASS: summary.flags.INVENTORY_GL_RECONCILIATION_PASS === true,
            GRNI_GL_RECONCILIATION_PASS: summary.flags.GRNI_GL_RECONCILIATION_PASS === true,
            COGS_RECONCILIATION_PASS: summary.flags.COGS_RECONCILIATION_PASS === true,
            AP_COMPATIBILITY_PASS: summary.flags.AP_COMPATIBILITY_PASS === true,
            BANKING_COMPATIBILITY_PASS: summary.flags.BANKING_COMPATIBILITY_PASS === true,
            PHASE11_1_COMPATIBILITY_PASS: summary.flags.PHASE11_1_COMPATIBILITY_PASS === true,
            INVENTORY_REPORTING_PASS: summary.flags.INVENTORY_REPORTING_PASS === true,
            GRNI_AGING_PASS: summary.flags.GRNI_AGING_PASS === true,
            PPV_REPORTING_PASS: summary.flags.PPV_REPORTING_PASS === true,
            CLOSE_INTEGRATION_PASS: summary.flags.CLOSE_INTEGRATION_PASS === true,
            ACCOUNTANT_PACKAGE_PASS: summary.flags.ACCOUNTANT_PACKAGE_PASS === true,
            TENANT_ISOLATION_PASS: summary.flags.TENANT_ISOLATION_PASS === true,
            HFAC_HARD_REFUSAL_PASS: summary.flags.HFAC_HARD_REFUSAL_PASS === true,
            HFAC_BASELINE_UNCHANGED: summary.flags.HFAC_BASELINE_UNCHANGED === true,
            ORPHAN_INVENTORY_MOVEMENTS: summary.flags.ORPHAN_INVENTORY_MOVEMENTS ?? 0,
            ORPHAN_INVENTORY_JOURNALS: summary.flags.ORPHAN_INVENTORY_JOURNALS ?? 0,
            ORPHAN_GRNI_SETTLEMENTS: summary.flags.ORPHAN_GRNI_SETTLEMENTS ?? 0,
            BROKEN_TRANSFER_GROUPS: summary.flags.BROKEN_TRANSFER_GROUPS ?? 0,
            failures: summary.failures,
          },
          null,
          2,
        ),
      );
      process.exit(summary.fail > 0 || !summary.hfacUnchanged ? 1 : 0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

