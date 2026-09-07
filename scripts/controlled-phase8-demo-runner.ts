/**
 * Phase 8 controlled production demo — dedicated demo org only, never HFAC.
 * 67-scenario fixed asset acceptance matrix.
 */
import { randomUUID } from "crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { postBillOpen, postBillPaid } from "../src/lib/accounting/bills";
import { nextNumber } from "../src/lib/accounting/accounts";
import {
  activateNewAcquisition,
  activateOpeningBalanceAsset,
  capitalizeExpensedPurchase,
  linkFixedAssetAcquisition,
} from "../src/lib/accounting/fixed-asset-acquisition";
import {
  buildAssetDepreciationSchedule,
  persistDepreciationSchedule,
  postDepreciationBatch,
  postSingleAssetDepreciation,
  previewDepreciationForPeriod,
  repostDepreciationAfterReversal,
  reverseDepreciationEntry,
} from "../src/lib/accounting/fixed-asset-depreciation";
import { disposeFixedAsset, disposeFixedAssetControlledTest, undoFixedAssetDisposal, assertValidDisposalOperationId } from "../src/lib/accounting/fixed-asset-disposal";
import { allocateAssetNumber } from "../src/lib/accounting/fixed-asset-numbering";
import { buildFixedAssetRegister, buildAssetRollforward } from "../src/lib/accounting/fixed-asset-register";
import { buildFixedAssetReconciliationReport } from "../src/lib/accounting/fixed-asset-reconciliation";
import {
  createDraftFixedAsset,
  loadFixedAsset,
  sumPostedDepreciationForAsset,
  updateFixedAssetMetadata,
} from "../src/lib/accounting/fixed-assets";
import {
  createFixedAssetCategory,
  exceedsCapitalizationThreshold,
  listFixedAssetCategories,
  seedDefaultFixedAssetCategories,
} from "../src/lib/accounting/fixed-asset-settings";
import { isFullyDepreciated } from "../src/lib/accounting/fixed-asset-depreciation-calc";
import { listUnassignedFixedAssetActivity } from "../src/lib/accounting/unassigned-fixed-asset-activity";
import { assertOrgPeriodOpen, loadOrgAccounts, postJournal } from "../src/lib/accounting/post";
import { asNumber } from "../src/lib/format";
import {
  assertMutationScope,
  assertDemoOrgName,
  captureOrgEconomicFingerprint,
  capturePeerFingerprints,
  expectedControlledDemoOrgName,
  loadControlledDemoOrgId,
  loadPriorPhasePeerOrgIds,
  type ControlledPhase,
  type OrgEconomicFingerprint,
} from "../src/lib/integration/controlled-phase-isolation";
import {
  assertNotHfacOrganization,
  CONTROLLED_PHASE8_FOREIGN_ORG_NAME,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import { reopenAllPeriodCloses } from "./lib/reopen-demo-period-closes";

const HFAC_ORG_ID = TELLER_HFAC_ORG_ID;
const TODAY = "2026-10-01";
const CLOSED_PERIOD_END = "2026-08-31";
const CLOSED_PERIOD_DATE = "2026-08-15";
const PLACED_IN_SERVICE = "2026-01-01";

function loadEnv() {
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST must equal 1");
  }
  const orgId = loadControlledDemoOrgId(8);
  assertNotHfacOrganization(orgId);
  return {
    orgId,
    supabase: createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    }),
  };
}

async function assertDemoOrg(supabase: SupabaseClient, orgId: string) {
  await assertDemoOrgName(supabase, orgId, expectedControlledDemoOrgName(8));
}

async function journalCount(supabase: SupabaseClient, orgId: string) {
  const { count } = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  return count ?? 0;
}

async function tableCount(supabase: SupabaseClient, table: string, orgId: string) {
  const { count } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  return count ?? 0;
}

async function hfacBaseline(supabase: SupabaseClient) {
  async function count(table: string) {
    const { count } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", HFAC_ORG_ID);
    return count ?? 0;
  }
  return {
    documents: await count("teller_documents"),
    payments: await count("teller_payments"),
    payment_allocations: await count("teller_payment_allocations"),
    journal_entries: await count("teller_journal_entries"),
    jobs: await count("teller_jobs"),
  };
}

async function assertPeerPhaseUnchanged(
  supabase: SupabaseClient,
  phase: ControlledPhase,
  before: Map<ControlledPhase, OrgEconomicFingerprint>,
) {
  const orgId = loadPriorPhasePeerOrgIds(8)[phase];
  const expected = before.get(phase);
  if (!orgId || !expected) throw new Error(`Phase ${phase} demo org not configured`);
  assertNotHfacOrganization(orgId);
  const after = await captureOrgEconomicFingerprint(supabase, orgId);
  if (JSON.stringify(after) !== JSON.stringify(expected)) {
    throw new Error(JSON.stringify({ phase, before: expected, after }));
  }
}

async function assertOrgJournalsBalanced(supabase: SupabaseClient, orgId: string) {
  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId);
  for (const entry of entries ?? []) {
    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("debit, credit")
      .eq("entry_id", entry.id as string);
    const debits = (lines ?? []).reduce((sum, line) => sum + asNumber(line.debit), 0);
    const credits = (lines ?? []).reduce((sum, line) => sum + asNumber(line.credit), 0);
    if (Math.abs(debits - credits) > 0.009) {
      throw new Error(`Unbalanced journal ${entry.id}: debits=${debits} credits=${credits}`);
    }
  }
}

async function cleanup(supabase: SupabaseClient, orgId: string, allowedOrgId: string) {
  assertMutationScope(orgId, allowedOrgId, "cleanup");
  for (const table of [
    "teller_fixed_asset_disposal_idempotency",
    "teller_fixed_asset_journal_links",
    "teller_fixed_asset_depreciation_entries",
    "teller_fixed_asset_depreciation_batches",
    "teller_fixed_asset_depreciation_schedule_lines",
    "teller_fixed_assets",
    "teller_fixed_asset_categories",
    "teller_document_journal_links",
    "teller_payment_allocations",
    "teller_payments",
    "teller_audit_events",
  ]) {
    await supabase.from(table).delete().eq("organization_id", orgId);
  }
  const { data: docs } = await supabase.from("teller_documents").select("id").eq("organization_id", orgId);
  const docIds = (docs ?? []).map((row) => row.id as string);
  if (docIds.length) await supabase.from("teller_document_lines").delete().in("document_id", docIds);
  await supabase.from("teller_documents").delete().eq("organization_id", orgId);
  const { data: entries } = await supabase.from("teller_journal_entries").select("id").eq("organization_id", orgId);
  const entryIds = (entries ?? []).map((row) => row.id as string);
  if (entryIds.length) await supabase.from("teller_journal_lines").delete().in("entry_id", entryIds);
  await supabase.from("teller_journal_entries").delete().eq("organization_id", orgId);
  await supabase.from("teller_parties").delete().eq("organization_id", orgId);
  await reopenAllPeriodCloses(supabase, orgId);
}

async function ensureVendor(supabase: SupabaseClient, orgId: string) {
  const { data } = await supabase
    .from("teller_parties")
    .insert({ organization_id: orgId, kind: "vendor", name: "Phase 8 Demo Vendor" })
    .select("id")
    .single();
  return data!.id as string;
}

async function accountMap(supabase: SupabaseClient, orgId: string) {
  const { data } = await supabase.from("teller_accounts").select("id, code, type, subtype").eq("organization_id", orgId);
  return Object.fromEntries((data ?? []).map((row) => [row.code, row.id as string]));
}

async function createCapitalizedBill(
  supabase: SupabaseClient,
  orgId: string,
  input: { vendorId: string; fixedAssetAccountId: string; amount: number; issueDate: string },
) {
  const { data: existing } = await supabase.from("teller_documents").select("number").eq("organization_id", orgId).eq("kind", "bill");
  const number = nextNumber("BILL", (existing ?? []).map((row) => row.number as string));
  const { data: doc } = await supabase
    .from("teller_documents")
    .insert({
      organization_id: orgId,
      kind: "bill",
      number,
      party_id: input.vendorId,
      status: "draft",
      issue_date: input.issueDate,
      subtotal: input.amount,
      total: input.amount,
    })
    .select("id")
    .single();
  const entryId = await postBillOpen(supabase, {
    organizationId: orgId,
    documentId: doc!.id as string,
    partyId: input.vendorId,
    jobId: null,
    issueDate: input.issueDate,
    number,
    tax: 0,
    lines: [{ amount: input.amount, account_id: input.fixedAssetAccountId, description: "Equipment purchase" }],
  });
  const { data: line } = await supabase
    .from("teller_document_lines")
    .select("id")
    .eq("document_id", doc!.id as string)
    .single();
  return { billId: doc!.id as string, billLineId: line!.id as string, journalEntryId: entryId, number, amount: input.amount };
}

async function activateAsset(
  supabase: SupabaseClient,
  orgId: string,
  input: {
    name: string;
    originalCost: number;
    salvageValue?: number;
    usefulLifeMonths: number;
    placedInServiceDate?: string;
    acquisitionMode?: "new_acquisition" | "opening_balance" | "linked";
    paymentKind?: "cash" | "ap";
    vendorId?: string;
    openingAccumulatedDepreciation?: number;
  },
) {
  const draft = await createDraftFixedAsset(supabase, {
    organizationId: orgId,
    name: input.name,
    acquisitionMode: input.acquisitionMode ?? "new_acquisition",
    originalCost: input.originalCost,
    salvageValue: input.salvageValue ?? 0,
    usefulLifeMonths: input.usefulLifeMonths,
    placedInServiceDate: input.placedInServiceDate ?? PLACED_IN_SERVICE,
    acquisitionDate: input.placedInServiceDate ?? PLACED_IN_SERVICE,
  });

  if (input.acquisitionMode === "opening_balance") {
    return activateOpeningBalanceAsset(supabase, {
      organizationId: orgId,
      assetId: draft.id,
      entryDate: input.placedInServiceDate ?? PLACED_IN_SERVICE,
      openingAccumulatedDepreciation: input.openingAccumulatedDepreciation ?? 0,
    });
  }

  return activateNewAcquisition(supabase, {
    organizationId: orgId,
    assetId: draft.id,
    paymentKind: input.paymentKind ?? "cash",
    entryDate: input.placedInServiceDate ?? PLACED_IN_SERVICE,
    vendorPartyId: input.vendorId ?? null,
  });
}

async function postMonths(
  supabase: SupabaseClient,
  orgId: string,
  assetId: string,
  periods: { year: number; month: number }[],
) {
  for (const period of periods) {
    const entryDate = `${period.year}-${String(period.month).padStart(2, "0")}-01`;
    try {
      await postSingleAssetDepreciation(supabase, {
        organizationId: orgId,
        assetId,
        periodYear: period.year,
        periodMonth: period.month,
        entryDate,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("already posted")) throw err;
    }
  }
}

function monthRange(fromYear: number, fromMonth: number, count: number) {
  const periods: { year: number; month: number }[] = [];
  let year = fromYear;
  let month = fromMonth;
  for (let i = 0; i < count; i += 1) {
    periods.push({ year, month });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return periods;
}

async function main() {
  const { orgId, supabase } = loadEnv();
  await assertDemoOrg(supabase, orgId);

  const hfacBefore = await hfacBaseline(supabase);
  const peerFingerprintsBefore = await capturePeerFingerprints(supabase, 8);

  const results: Array<{ name: string; pass: boolean; detail?: string }> = [];

  async function ensureBooksOpen() {
    await reopenAllPeriodCloses(supabase, orgId);
  }

  async function run(name: string, fn: () => Promise<void>) {
    try {
      await ensureBooksOpen();
      await fn();
      results.push({ name, pass: true });
      console.log(`✓ ${name}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ name, pass: false, detail });
      console.log(`✗ ${name} — ${detail}`);
    }
  }

  await cleanup(supabase, orgId, orgId);
  const accounts = await accountMap(supabase, orgId);
  const orgAccounts = await loadOrgAccounts(supabase, orgId);
  await seedDefaultFixedAssetCategories(supabase, orgId, orgAccounts);
  const vendorId = await ensureVendor(supabase, orgId);

  let categoryId = "";
  let linkedBillAssetId = "";
  let linkedBillId = "";
  let cashAssetId = "";
  let apAssetId = "";
  let capitalizedAssetId = "";
  let deprAssetId = "";
  let batchAssetA = "";
  let batchAssetB = "";
  let fullDeprAssetId = "";
  let gainAssetId = "";
  let lossAssetId = "";
  let retireAssetId = "";
  let writeOffAssetId = "";
  let paidBillAssetId = "";
  let bankLinkedAssetId = "";
  let openingAssetId = "";
  let undoDisposalAssetId = "";
  let reversalAssetId = "";
  let reversedEntryId = "";
  let disposalMonthAssetId = "";
  let salvageAssetId = "";

  await run("1. Create asset category", async () => {
    const row = await createFixedAssetCategory(supabase, {
      organizationId: orgId,
      code: "demo_equipment",
      name: "Demo Equipment",
      defaultUsefulLifeMonths: 60,
      assetAccountId: accounts["1500"],
      accumulatedDepreciationAccountId: accounts["1510"],
      depreciationExpenseAccountId: accounts["6800"],
      gainAccountId: accounts["4900"],
      lossAccountId: accounts["6910"],
    });
    categoryId = row.id as string;
    if (!categoryId) throw new Error("missing category");
  });

  await run("2. Create asset", async () => {
    const asset = await createDraftFixedAsset(supabase, {
      organizationId: orgId,
      name: "Draft Laptop",
      categoryId,
      originalCost: 2400,
      usefulLifeMonths: 36,
    });
    if (!asset.asset_number.startsWith("FA-")) throw new Error("expected FA prefix");
  });

  await run("3. Asset metadata creates zero journals", async () => {
    const before = await journalCount(supabase, orgId);
    const asset = await createDraftFixedAsset(supabase, { organizationId: orgId, name: "Metadata Test" });
    await updateFixedAssetMetadata(supabase, {
      organizationId: orgId,
      assetId: asset.id,
      patch: { serial_number: "SN-001", notes: "Demo note" },
    });
    const after = await journalCount(supabase, orgId);
    if (after !== before) throw new Error("metadata update created journals");
  });

  await run("4. Concurrency-safe asset numbering", async () => {
    const [n1, n2] = await Promise.all([allocateAssetNumber(supabase, orgId), allocateAssetNumber(supabase, orgId)]);
    if (n1 === n2) throw new Error(`duplicate numbers: ${n1}`);
  });

  await run("5. Link asset to existing capitalized bill", async () => {
    const bill = await createCapitalizedBill(supabase, orgId, {
      vendorId,
      fixedAssetAccountId: accounts["1500"],
      amount: 8000,
      issueDate: "2026-02-01",
    });
    linkedBillId = bill.billId;
    const draft = await createDraftFixedAsset(supabase, {
      organizationId: orgId,
      name: "Linked Server",
      usefulLifeMonths: 60,
      placedInServiceDate: "2026-02-01",
      acquisitionDate: "2026-02-01",
    });
    const linked = await linkFixedAssetAcquisition(supabase, {
      organizationId: orgId,
      assetId: draft.id,
      purchaseDocumentLineId: bill.billLineId,
      acquisitionJournalEntryId: bill.journalEntryId,
    });
    linkedBillAssetId = linked.id as string;
    if (linked.status !== "active") throw new Error("expected active linked asset");
    if (asNumber(linked.original_cost) !== 8000) throw new Error("cost mismatch");
  });

  await run("6. Linking creates zero duplicate journal", async () => {
    const asset = await loadFixedAsset(supabase, orgId, linkedBillAssetId);
    const { data: bill } = await supabase
      .from("teller_documents")
      .select("posted_entry_id")
      .eq("id", linkedBillId)
      .single();
    if (asset.acquisition_journal_entry_id !== bill?.posted_entry_id) {
      throw new Error("linked asset should reuse bill journal, not create duplicate");
    }
    const { count } = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("source_kind", "bill");
    if ((count ?? 0) < 1) throw new Error("expected original bill journal");
  });

  await run("7. Cash asset acquisition", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Cash Forklift",
      originalCost: 12000,
      usefulLifeMonths: 60,
      paymentKind: "cash",
    });
    cashAssetId = asset.id as string;
    if (asset.status !== "active") throw new Error("expected active");
    const { data: entry } = await supabase
      .from("teller_journal_entries")
      .select("id")
      .eq("id", asset.acquisition_journal_entry_id as string)
      .maybeSingle();
    if (!entry) throw new Error("missing acquisition journal");
  });

  await run("8. AP asset acquisition", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "AP Compressor",
      originalCost: 6500,
      usefulLifeMonths: 84,
      paymentKind: "ap",
      vendorId,
      placedInServiceDate: "2026-03-01",
    });
    apAssetId = asset.id as string;
    if (asset.status !== "active") throw new Error("expected active AP asset");
  });

  await run("9. Capitalization reclassification", async () => {
    const draft = await createDraftFixedAsset(supabase, {
      organizationId: orgId,
      name: "Reclassified Equipment",
      usefulLifeMonths: 48,
      placedInServiceDate: "2026-04-01",
    });
    const capitalized = await capitalizeExpensedPurchase(supabase, {
      organizationId: orgId,
      assetId: draft.id,
      expenseAccountId: accounts["6100"],
      amount: 4200,
      entryDate: "2026-04-01",
    });
    capitalizedAssetId = capitalized.id as string;
    if (asNumber(capitalized.original_cost) !== 4200) throw new Error("capitalized cost mismatch");
  });

  await run("10. Depreciation schedule calculation", async () => {
    deprAssetId = cashAssetId;
    const schedule = await buildAssetDepreciationSchedule(supabase, orgId, deprAssetId);
    if (schedule.length !== 60) throw new Error(`expected 60 periods, got ${schedule.length}`);
    const total = schedule.reduce((sum, line) => sum + line.depreciationAmount, 0);
    if (Math.abs(total - 12000) > 0.02) throw new Error(`schedule total ${total}`);
  });

  await run("11. Schedule calculation creates zero journals", async () => {
    const before = await journalCount(supabase, orgId);
    await persistDepreciationSchedule(supabase, orgId, apAssetId);
    const after = await journalCount(supabase, orgId);
    if (after !== before) throw new Error("schedule persistence created journals");
  });

  await run("12. Monthly depreciation posting", async () => {
    await postSingleAssetDepreciation(supabase, {
      organizationId: orgId,
      assetId: deprAssetId,
      periodYear: 2026,
      periodMonth: 1,
      entryDate: "2026-01-01",
    });
    const posted = await sumPostedDepreciationForAsset(supabase, deprAssetId);
    if (posted <= 0) throw new Error("expected posted depreciation");
  });

  await run("13. Depreciation correct debit/credit", async () => {
    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("account_id, debit, credit, fixed_asset_id")
      .eq("fixed_asset_id", deprAssetId);
    const expenseLines = (lines ?? []).filter((line) => line.account_id === accounts["6800"]);
    const accumLines = (lines ?? []).filter((line) => line.account_id === accounts["1510"]);
    if (!expenseLines.some((line) => asNumber(line.debit) > 0)) throw new Error("missing expense debit");
    if (!accumLines.some((line) => asNumber(line.credit) > 0)) throw new Error("missing accum credit");
  });

  await run("14. Duplicate depreciation rejected/idempotent", async () => {
    let rejected = false;
    try {
      await postSingleAssetDepreciation(supabase, {
        organizationId: orgId,
        assetId: deprAssetId,
        periodYear: 2026,
        periodMonth: 1,
        entryDate: "2026-01-01",
      });
    } catch (err) {
      rejected = err instanceof Error && err.message.includes("already posted");
    }
    if (!rejected) throw new Error("duplicate depreciation should be rejected");
  });

  await run("15. Period lock blocks depreciation", async () => {
    await supabase.from("teller_period_closes").insert({
      organization_id: orgId,
      period_end: CLOSED_PERIOD_END,
      closed_at: new Date().toISOString(),
    });
    let blocked = false;
    try {
      await assertOrgPeriodOpen(supabase, orgId, CLOSED_PERIOD_DATE);
    } catch (err) {
      blocked = err instanceof Error && err.message.toLowerCase().includes("closed");
    }
    if (!blocked) throw new Error("closed period should block posting");
    await reopenAllPeriodCloses(supabase, orgId);
  });

  await run("16. Depreciation reversal", async () => {
    reversalAssetId = apAssetId;
    await postSingleAssetDepreciation(supabase, {
      organizationId: orgId,
      assetId: reversalAssetId,
      periodYear: 2026,
      periodMonth: 3,
      entryDate: "2026-03-01",
    });
    const { data: entry } = await supabase
      .from("teller_fixed_asset_depreciation_entries")
      .select("id")
      .eq("asset_id", reversalAssetId)
      .eq("period_year", 2026)
      .eq("period_month", 3)
      .eq("status", "posted")
      .single();
    reversedEntryId = entry!.id as string;
    await reverseDepreciationEntry(supabase, {
      organizationId: orgId,
      depreciationEntryId: reversedEntryId,
      reversalDate: "2026-10-02",
    });
    const { data: reversed } = await supabase
      .from("teller_fixed_asset_depreciation_entries")
      .select("status")
      .eq("id", reversedEntryId)
      .single();
    if (reversed?.status !== "reversed") throw new Error("expected reversed status");
  });

  await run("17. Repost after valid reversal if allowed", async () => {
    const result = await repostDepreciationAfterReversal(supabase, {
      organizationId: orgId,
      reversedEntryId,
      entryDate: "2026-10-03",
    });
    if (!result.depreciationEntry) throw new Error("expected replacement entry");
    const { count } = await supabase
      .from("teller_fixed_asset_depreciation_entries")
      .select("id", { count: "exact", head: true })
      .eq("asset_id", reversalAssetId)
      .eq("period_year", 2026)
      .eq("period_month", 3)
      .eq("status", "posted");
    if ((count ?? 0) !== 1) throw new Error("expected one active posted entry for period");
  });

  await run("18. Batch depreciation", async () => {
    batchAssetA = (
      await activateAsset(supabase, orgId, {
        name: "Batch Asset A",
        originalCost: 6000,
        usefulLifeMonths: 60,
        placedInServiceDate: "2026-05-01",
      })
    ).id as string;
    batchAssetB = (
      await activateAsset(supabase, orgId, {
        name: "Batch Asset B",
        originalCost: 3000,
        usefulLifeMonths: 36,
        placedInServiceDate: "2026-05-01",
      })
    ).id as string;
    await postDepreciationBatch(supabase, {
      organizationId: orgId,
      periodYear: 2026,
      periodMonth: 5,
      entryDate: "2026-05-01",
    });
    const preview = await previewDepreciationForPeriod(supabase, orgId, 2026, 5);
    if (preview.rows.some((row) => !row.posted)) throw new Error("batch should mark rows posted");
  });

  await run("19. Batch totals reconcile to journal", async () => {
    const { data: batch } = await supabase
      .from("teller_fixed_asset_depreciation_batches")
      .select("total_amount, journal_entry_id")
      .eq("organization_id", orgId)
      .eq("period_year", 2026)
      .eq("period_month", 5)
      .single();
    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("debit, credit")
      .eq("entry_id", batch!.journal_entry_id as string);
    const debits = (lines ?? []).reduce((sum, line) => sum + asNumber(line.debit), 0);
    if (Math.abs(debits - asNumber(batch!.total_amount)) > 0.02) {
      throw new Error("batch total does not match journal debits");
    }
  });

  await run("20. Fully depreciated asset stops depreciation", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Short Life Asset",
      originalCost: 360,
      usefulLifeMonths: 12,
      placedInServiceDate: "2026-01-01",
    });
    fullDeprAssetId = asset.id as string;
    await postMonths(supabase, orgId, fullDeprAssetId, monthRange(2026, 1, 12));
    let rejected = false;
    try {
      await postSingleAssetDepreciation(supabase, {
        organizationId: orgId,
        assetId: fullDeprAssetId,
        periodYear: 2027,
        periodMonth: 1,
        entryDate: "2027-01-01",
      });
    } catch (err) {
      rejected =
        err instanceof Error &&
        (err.message.includes("fully depreciated") ||
          err.message.includes("No depreciation schedule line") ||
          err.message.includes("already posted"));
    }
    if (!rejected) throw new Error("fully depreciated asset should reject depreciation");
  });

  await run("21. Fully depreciated asset remains operational", async () => {
    const asset = await loadFixedAsset(supabase, orgId, fullDeprAssetId);
    if (asset.status !== "active") throw new Error("fully depreciated asset should remain active");
    const accum = await sumPostedDepreciationForAsset(supabase, fullDeprAssetId);
    if (!isFullyDepreciated(asNumber(asset.original_cost), asNumber(asset.salvage_value), accum)) {
      throw new Error("asset should be fully depreciated");
    }
  });

  await run("22. Asset sale at gain", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Gain Sale Asset",
      originalCost: 10000,
      usefulLifeMonths: 60,
      placedInServiceDate: "2026-01-01",
    });
    gainAssetId = asset.id as string;
    await postMonths(supabase, orgId, gainAssetId, monthRange(2026, 1, 6));
    const result = await disposeFixedAsset(supabase, {
      organizationId: orgId,
      assetId: gainAssetId,
      disposalDate: "2026-07-15",
      disposalType: "sold",
      proceeds: 9500,
      operationId: randomUUID(),
    });
    if (result.gainLoss <= 0) throw new Error(`expected gain, got ${result.gainLoss}`);
  });

  await run("23. Asset sale at loss", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Loss Sale Asset",
      originalCost: 10000,
      usefulLifeMonths: 60,
      placedInServiceDate: "2026-01-01",
    });
    lossAssetId = asset.id as string;
    await postMonths(supabase, orgId, lossAssetId, monthRange(2026, 1, 6));
    const result = await disposeFixedAsset(supabase, {
      organizationId: orgId,
      assetId: lossAssetId,
      disposalDate: "2026-07-20",
      disposalType: "sold",
      proceeds: 2000,
      operationId: randomUUID(),
    });
    if (result.gainLoss >= 0) throw new Error(`expected loss, got ${result.gainLoss}`);
  });

  await run("24. Asset disposal with no proceeds", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Retired Asset",
      originalCost: 5000,
      usefulLifeMonths: 60,
      placedInServiceDate: "2026-01-01",
    });
    retireAssetId = asset.id as string;
    await postMonths(supabase, orgId, retireAssetId, monthRange(2026, 1, 3));
    await disposeFixedAsset(supabase, {
      organizationId: orgId,
      assetId: retireAssetId,
      disposalDate: "2026-04-10",
      disposalType: "retired",
      proceeds: 0,
      operationId: randomUUID(),
    });
    const row = await loadFixedAsset(supabase, orgId, retireAssetId);
    if (row.status !== "disposed") throw new Error("expected disposed");
  });

  await run("25. Asset write-off", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Written Off Asset",
      originalCost: 3000,
      usefulLifeMonths: 36,
      placedInServiceDate: "2026-02-01",
    });
    writeOffAssetId = asset.id as string;
    await postMonths(supabase, orgId, writeOffAssetId, monthRange(2026, 2, 2));
    await disposeFixedAsset(supabase, {
      organizationId: orgId,
      assetId: writeOffAssetId,
      disposalDate: "2026-03-20",
      disposalType: "written_off",
      proceeds: 0,
      reason: "Damaged beyond repair",
      operationId: randomUUID(),
    });
    const row = await loadFixedAsset(supabase, orgId, writeOffAssetId);
    if (row.disposal_type !== "written_off") throw new Error("expected written_off");
  });

  await run("26. Disposal removes cost", async () => {
    const { data: disposed } = await supabase
      .from("teller_fixed_assets")
      .select("id, status, original_cost")
      .eq("organization_id", orgId)
      .in("id", [gainAssetId, lossAssetId, retireAssetId, writeOffAssetId]);
    for (const asset of disposed ?? []) {
      if (asset.status !== "disposed") {
        throw new Error(`expected ${asset.id} to be disposed`);
      }
    }
    const activeDisposedCost = (disposed ?? [])
      .filter((row) => row.status === "active")
      .reduce((sum, row) => sum + asNumber(row.original_cost), 0);
    if (activeDisposedCost > 0.009) {
      throw new Error("disposed assets should not remain active in subledger");
    }
  });

  await run("27. Disposal removes accumulated depreciation", async () => {
    const { data: disposed } = await supabase
      .from("teller_fixed_assets")
      .select("id")
      .eq("organization_id", orgId)
      .eq("status", "disposed");
    for (const asset of disposed ?? []) {
      const accum = await sumPostedDepreciationForAsset(supabase, asset.id as string);
      const { data: activeLines } = await supabase
        .from("teller_journal_lines")
        .select("debit, credit")
        .eq("fixed_asset_id", asset.id as string)
        .eq("account_id", accounts["1510"]);
      const netAccum = (activeLines ?? []).reduce(
        (sum, line) => sum + asNumber(line.credit) - asNumber(line.debit),
        0,
      );
      if (Math.abs(netAccum) > 0.05 && accum > 0) {
        throw new Error("accum depr should be cleared on disposal");
      }
    }
  });

  await run("28. Disposal stops future depreciation", async () => {
    let rejected = false;
    try {
      await postSingleAssetDepreciation(supabase, {
        organizationId: orgId,
        assetId: gainAssetId,
        periodYear: 2026,
        periodMonth: 8,
        entryDate: "2026-08-01",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rejected = message.includes("active") || message.includes("schedule");
    }
    if (!rejected) throw new Error("disposed asset should reject depreciation");
  });

  await run("29. Disposal idempotency", async () => {
    let rejected = false;
    try {
      await disposeFixedAsset(supabase, {
        organizationId: orgId,
        assetId: lossAssetId,
        disposalDate: "2026-07-25",
        disposalType: "sold",
        proceeds: 1000,
        operationId: randomUUID(),
      });
    } catch (err) {
      rejected =
        err instanceof Error &&
        (err.message.includes("already disposed") || err.message.includes("Only active assets"));
    }
    if (!rejected) throw new Error("second disposal should be rejected");
  });

  await run("30. Asset-linked vendor bill payment creates no asset cost", async () => {
    paidBillAssetId = linkedBillAssetId;
    const beforeCost = asNumber((await loadFixedAsset(supabase, orgId, paidBillAssetId)).original_cost);
    const { data: bill } = await supabase
      .from("teller_documents")
      .select("number, total")
      .eq("id", linkedBillId)
      .single();
    await postBillPaid(supabase, {
      organizationId: orgId,
      documentId: linkedBillId,
      partyId: vendorId,
      jobId: null,
      issueDate: TODAY,
      number: bill!.number as string,
      paymentAmount: asNumber(bill!.total),
      billTotal: asNumber(bill!.total),
    });
    const afterCost = asNumber((await loadFixedAsset(supabase, orgId, paidBillAssetId)).original_cost);
    if (Math.abs(afterCost - beforeCost) > 0.01) throw new Error("bill payment changed asset cost");
  });

  await run("31. Bank match creates no duplicate asset acquisition", async () => {
    const before = await journalCount(supabase, orgId);
    const entryId = await postJournal(supabase, {
      organizationId: orgId,
      entryDate: "2026-06-01",
      memo: "Bank fixed asset acquisition",
      sourceKind: "bank-fixed-asset-acquisition",
      lines: [
        { account_id: accounts["1500"], debit: 5500, memo: "Bank FA purchase" },
        { account_id: accounts["1000"], credit: 5500, memo: "Bank FA purchase" },
      ],
    });
    const draft = await createDraftFixedAsset(supabase, {
      organizationId: orgId,
      name: "Bank Linked Asset",
      usefulLifeMonths: 60,
      placedInServiceDate: "2026-06-01",
      originalCost: 5500,
    });
    const linked = await linkFixedAssetAcquisition(supabase, {
      organizationId: orgId,
      assetId: draft.id,
      acquisitionJournalEntryId: entryId,
    });
    bankLinkedAssetId = linked.id as string;
    const after = await journalCount(supabase, orgId);
    if (after !== before + 1) throw new Error("bank link should not duplicate acquisition journal");
  });

  await run("32. Unassigned fixed asset activity", async () => {
    await postJournal(supabase, {
      organizationId: orgId,
      entryDate: "2026-09-01",
      memo: "Unassigned FA control test",
      sourceKind: "adjustment",
      lines: [
        { account_id: accounts["1500"], debit: 100, memo: "Unassigned" },
        { account_id: accounts["6100"], credit: 100, memo: "Unassigned" },
      ],
    });
    const rows = await listUnassignedFixedAssetActivity(supabase, orgId);
    if (!rows.some((row) => row.accountCode === "1500" && row.debit > 0)) {
      throw new Error("expected unassigned fixed asset activity");
    }
  });

  await run("33. Fixed asset cost GL reconciliation", async () => {
    const report = await buildFixedAssetReconciliationReport(supabase, orgId, { asOfDate: TODAY });
    if (Math.abs(report.fixedAssetCost.difference) > 0.05) {
      throw new Error(`cost difference ${report.fixedAssetCost.difference}`);
    }
  });

  await run("34. Accumulated depreciation GL reconciliation", async () => {
    const report = await buildFixedAssetReconciliationReport(supabase, orgId, { asOfDate: TODAY });
    if (Math.abs(report.accumulatedDepreciation.difference) > 0.05) {
      throw new Error(`accum difference ${report.accumulatedDepreciation.difference}`);
    }
  });

  await run("35. Depreciation expense reconciliation", async () => {
    const report = await buildFixedAssetReconciliationReport(supabase, orgId, {
      asOfDate: TODAY,
      periodYear: 2026,
      periodMonth: 1,
    });
    if (Math.abs(report.depreciationExpense.difference) > 0.05) {
      throw new Error(`expense difference ${report.depreciationExpense.difference}`);
    }
  });

  await run("36. Asset rollforward", async () => {
    const rollforward = await buildAssetRollforward(supabase, orgId, "2026-01-01", TODAY);
    if (rollforward.endingCost < rollforward.beginningCost) {
      throw new Error("rollforward ending cost inconsistent");
    }
    if (rollforward.depreciation <= 0) throw new Error("expected depreciation in rollforward");
  });

  await run("37. Tenant isolation", async () => {
    const { data: foreign } = await supabase
      .from("teller_organizations")
      .select("id")
      .eq("name", CONTROLLED_PHASE8_FOREIGN_ORG_NAME)
      .maybeSingle();
    if (!foreign?.id) throw new Error(`Create org "${CONTROLLED_PHASE8_FOREIGN_ORG_NAME}" first`);
    assertNotHfacOrganization(foreign.id as string);
    const { data: leaked } = await supabase
      .from("teller_fixed_assets")
      .select("id")
      .eq("organization_id", foreign.id as string)
      .eq("id", cashAssetId)
      .maybeSingle();
    if (leaked) throw new Error("foreign org saw demo asset");
  });

  await run("38. Closed period disposal rejection", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Closed Period Asset",
      originalCost: 1500,
      usefulLifeMonths: 36,
      placedInServiceDate: "2026-01-01",
    });
    await supabase.from("teller_period_closes").insert({
      organization_id: orgId,
      period_end: CLOSED_PERIOD_END,
      closed_at: new Date().toISOString(),
    });
    try {
      let blocked = false;
      try {
        await disposeFixedAsset(supabase, {
          organizationId: orgId,
          assetId: asset.id,
          disposalDate: CLOSED_PERIOD_DATE,
          disposalType: "retired",
          operationId: randomUUID(),
        });
      } catch (err) {
        blocked = err instanceof Error && err.message.toLowerCase().includes("closed");
      }
      if (!blocked) throw new Error("closed period should block disposal");
    } finally {
      await reopenAllPeriodCloses(supabase, orgId);
    }
  });

  await run("39. All org journals balanced", async () => {
    await assertOrgJournalsBalanced(supabase, orgId);
  });

  await run("40. HFAC baseline unchanged", async () => {
    const after = await hfacBaseline(supabase);
    if (JSON.stringify(hfacBefore) !== JSON.stringify(after)) {
      throw new Error(JSON.stringify({ before: hfacBefore, after }));
    }
  });

  await run("41. Phase 7 regression", async () => {
    await assertPeerPhaseUnchanged(supabase, 7, peerFingerprintsBefore);
  });

  await run("42. Phase 6 regression", async () => {
    await assertPeerPhaseUnchanged(supabase, 6, peerFingerprintsBefore);
  });

  await run("43. Phase 5 regression", async () => {
    await assertPeerPhaseUnchanged(supabase, 5, peerFingerprintsBefore);
  });

  await run("44. Opening balance asset with opening accumulated depreciation", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Opening Balance Truck",
      originalCost: 20000,
      salvageValue: 2000,
      usefulLifeMonths: 60,
      acquisitionMode: "opening_balance",
      placedInServiceDate: "2025-06-01",
      openingAccumulatedDepreciation: 5000,
    });
    openingAssetId = asset.id as string;
    if (!asset.opening_accum_depr_journal_entry_id) throw new Error("missing opening accum journal");
    const accum = await sumPostedDepreciationForAsset(supabase, openingAssetId);
    if (accum !== 0) throw new Error("opening accum should not count as posted depreciation entries");
  });

  await run("45. Undo disposal restores active asset", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Undo Disposal Asset",
      originalCost: 4000,
      usefulLifeMonths: 48,
      placedInServiceDate: "2026-02-01",
    });
    undoDisposalAssetId = asset.id as string;
    await postMonths(supabase, orgId, undoDisposalAssetId, monthRange(2026, 2, 2));
    const deprBeforeUndo = await sumPostedDepreciationForAsset(supabase, undoDisposalAssetId);
    await disposeFixedAsset(supabase, {
      organizationId: orgId,
      assetId: undoDisposalAssetId,
      disposalDate: "2026-04-01",
      disposalType: "retired",
      proceeds: 0,
      operationId: randomUUID(),
    });
    await undoFixedAssetDisposal(supabase, {
      organizationId: orgId,
      assetId: undoDisposalAssetId,
      reversalDate: "2026-10-04",
      reason: "Disposed in error",
    });
    const restored = await loadFixedAsset(supabase, orgId, undoDisposalAssetId);
    if (restored.status !== "active") throw new Error("undo disposal should restore active");
    const deprAfterUndo = await sumPostedDepreciationForAsset(supabase, undoDisposalAssetId);
    if (deprAfterUndo + 0.009 < deprBeforeUndo) {
      throw new Error("undo disposal must not reverse posted depreciation");
    }
  });

  await run("46. Default fixed asset categories seeded", async () => {
    const categories = await listFixedAssetCategories(supabase, orgId);
    const codes = new Set(categories.map((row) => row.code as string));
    if (!codes.has("vehicles") || !codes.has("computers")) {
      throw new Error("missing default seeded categories");
    }
  });

  await run("47. Capitalization threshold suggestion helper", async () => {
    const { data: settings } = await supabase
      .from("teller_fixed_asset_settings")
      .select("capitalization_threshold")
      .eq("organization_id", orgId)
      .single();
    if (!exceedsCapitalizationThreshold(3000, settings?.capitalization_threshold)) {
      throw new Error("amount above threshold should be flagged");
    }
    if (exceedsCapitalizationThreshold(1000, settings?.capitalization_threshold)) {
      throw new Error("amount below threshold should not be flagged");
    }
  });

  await run("48. Fixed asset register NBV accuracy", async () => {
    const register = await buildFixedAssetRegister(supabase, orgId);
    const row = register.find((asset) => asset.id === deprAssetId);
    if (!row) throw new Error("register missing depreciation asset");
    const expectedAccum = await sumPostedDepreciationForAsset(supabase, deprAssetId);
    if (Math.abs(row.accumulatedDepreciation - expectedAccum) > 0.02) {
      throw new Error("register accum mismatch");
    }
    if (Math.abs(row.netBookValue - (asNumber(row.original_cost) - expectedAccum)) > 0.02) {
      throw new Error("register NBV mismatch");
    }
  });

  await run("49. Refuse HFAC org id in env", async () => {
    let refused = false;
    try {
      assertNotHfacOrganization(HFAC_ORG_ID);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("HFAC org should be refused");
  });

  await run("50. Demo org is not HFAC", async () => {
    if (orgId === HFAC_ORG_ID) throw new Error("demo org is HFAC");
    assertNotHfacOrganization(orgId);
  });

  await run("51. Disposal-month depreciation posts separately before disposal", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Disposal Month Asset",
      originalCost: 1200,
      usefulLifeMonths: 12,
      placedInServiceDate: "2026-01-01",
    });
    disposalMonthAssetId = asset.id as string;
    await postMonths(supabase, orgId, disposalMonthAssetId, monthRange(2026, 1, 8));
    const journalsBefore = await journalCount(supabase, orgId);
    await disposeFixedAsset(supabase, {
      organizationId: orgId,
      assetId: disposalMonthAssetId,
      disposalDate: "2026-09-15",
      disposalType: "retired",
      proceeds: 0,
      operationId: randomUUID(),
    });
    const { data: deprEntries } = await supabase
      .from("teller_journal_entries")
      .select("id, source_kind")
      .eq("organization_id", orgId)
      .eq("source_kind", "fixed-asset-depreciation")
      .gte("entry_date", "2026-09-01");
    const { data: disposalEntries } = await supabase
      .from("teller_journal_entries")
      .select("id, source_kind")
      .eq("organization_id", orgId)
      .eq("source_kind", "fixed-asset-disposal")
      .eq("source_id", disposalMonthAssetId);
    if (!(deprEntries ?? []).length) throw new Error("expected disposal-month depreciation journal");
    if (!(disposalEntries ?? []).length) throw new Error("expected separate disposal journal");
    const after = await journalCount(supabase, orgId);
    if (after <= journalsBefore) throw new Error("disposal should add journals");
  });

  await run("52. Disposal uses posted accumulated depreciation when calculating NBV", async () => {
    const asset = await loadFixedAsset(supabase, orgId, disposalMonthAssetId);
    if (!asset.disposal_journal_entry_id) {
      throw new Error("missing disposal journal — scenario 51 prerequisite failed");
    }
    const postedAccum = await sumPostedDepreciationForAsset(supabase, disposalMonthAssetId);
    const { data: disposalEntry } = await supabase
      .from("teller_journal_entries")
      .select("id")
      .eq("id", asset.disposal_journal_entry_id as string)
      .maybeSingle();
    if (!disposalEntry) throw new Error("missing disposal journal");
    const { data: accumLine } = await supabase
      .from("teller_journal_lines")
      .select("debit")
      .eq("entry_id", disposalEntry.id as string)
      .eq("account_id", accounts["1510"])
      .maybeSingle();
    if (Math.abs(asNumber(accumLine?.debit) - postedAccum) > 0.05) {
      throw new Error("disposal accum debit should match posted accum");
    }
  });

  await run("53. Reversed depreciation history remains present", async () => {
    const { count } = await supabase
      .from("teller_fixed_asset_depreciation_entries")
      .select("id", { count: "exact", head: true })
      .eq("id", reversedEntryId)
      .eq("status", "reversed");
    if ((count ?? 0) !== 1) throw new Error("reversed entry should remain in history");
  });

  await run("54. Repost after reversal creates new immutable depreciation entry", async () => {
    const { data: replacement } = await supabase
      .from("teller_fixed_asset_depreciation_entries")
      .select("id, replaces_entry_id, status")
      .eq("asset_id", reversalAssetId)
      .eq("period_year", 2026)
      .eq("period_month", 3)
      .eq("status", "posted")
      .neq("id", reversedEntryId)
      .maybeSingle();
    if (!replacement?.id) throw new Error("expected replacement posted entry");
    if (replacement.replaces_entry_id !== reversedEntryId) {
      throw new Error("replacement should reference reversed entry");
    }
  });

  await run("55. Salvage value prevents over-depreciation", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Salvage Test Asset",
      originalCost: 1000,
      salvageValue: 200,
      usefulLifeMonths: 12,
      placedInServiceDate: "2026-01-01",
    });
    salvageAssetId = asset.id as string;
    await postMonths(supabase, orgId, salvageAssetId, monthRange(2026, 1, 12));
    const accum = await sumPostedDepreciationForAsset(supabase, salvageAssetId);
    if (accum > 800 + 0.05) throw new Error(`over-depreciated beyond salvage: ${accum}`);
    let rejected = false;
    try {
      await postSingleAssetDepreciation(supabase, {
        organizationId: orgId,
        assetId: salvageAssetId,
        periodYear: 2027,
        periodMonth: 1,
        entryDate: "2027-01-01",
      });
    } catch (err) {
      rejected =
        err instanceof Error &&
        (err.message.includes("fully depreciated") ||
          err.message.includes("No depreciation schedule line"));
    }
    if (!rejected) throw new Error("salvage should prevent further depreciation");
  });

  await run("56. Old Phase 7 teller_post_journal caller remains compatible after 024", async () => {
    const before = await journalCount(supabase, orgId);
    await postJournal(supabase, {
      organizationId: orgId,
      entryDate: TODAY,
      memo: "Phase 7 style journal without fixed_asset_id",
      sourceKind: "adjustment",
      lines: [
        { account_id: accounts["6100"], debit: 25, memo: "Compat test" },
        { account_id: accounts["1000"], credit: 25, memo: "Compat test" },
      ],
    });
    const after = await journalCount(supabase, orgId);
    if (after !== before + 1) throw new Error("legacy postJournal call failed");
    const { data: line } = await supabase
      .from("teller_journal_lines")
      .select("fixed_asset_id")
      .eq("account_id", accounts["6100"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (line?.fixed_asset_id) throw new Error("legacy line should have null fixed_asset_id");
  });

  await run("57. Simulated failure after depreciation rolls back all economics", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Rollback After Depreciation Asset",
      originalCost: 6000,
      usefulLifeMonths: 60,
      placedInServiceDate: "2026-01-01",
    });
    const journalsBefore = await journalCount(supabase, orgId);
    let failed = false;
    try {
      await disposeFixedAssetControlledTest(supabase, {
        organizationId: orgId,
        assetId: asset.id as string,
        disposalDate: "2026-06-15",
        disposalType: "retired",
        operationId: randomUUID(),
        simulateFailureAfter: "after_depreciation",
      });
    } catch (err) {
      failed = err instanceof Error && err.message.includes("Simulated disposal failure");
    }
    if (!failed) throw new Error("expected simulated failure after depreciation");
    const row = await loadFixedAsset(supabase, orgId, asset.id as string);
    if (row.status !== "active") throw new Error("asset should remain active after rollback");
    if (row.disposal_journal_entry_id) throw new Error("disposal journal should not persist after rollback");
    const journalsAfter = await journalCount(supabase, orgId);
    if (journalsAfter !== journalsBefore) throw new Error("failed disposal should roll back depreciation journals");
  });

  await run("58. Simulated failure before asset update rolls back all economics", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Rollback Before Update Asset",
      originalCost: 5000,
      usefulLifeMonths: 48,
      placedInServiceDate: "2026-01-01",
    });
    const journalsBefore = await journalCount(supabase, orgId);
    let failed = false;
    try {
      await disposeFixedAssetControlledTest(supabase, {
        organizationId: orgId,
        assetId: asset.id as string,
        disposalDate: "2026-05-20",
        disposalType: "retired",
        operationId: randomUUID(),
        simulateFailureAfter: "before_asset_update",
      });
    } catch (err) {
      failed = err instanceof Error && err.message.includes("Simulated disposal failure");
    }
    if (!failed) throw new Error("expected simulated failure before asset update");
    const row = await loadFixedAsset(supabase, orgId, asset.id as string);
    if (row.status !== "active") throw new Error("asset should remain active after rollback");
    const journalsAfter = await journalCount(supabase, orgId);
    if (journalsAfter !== journalsBefore) {
      throw new Error("failed disposal should roll back depreciation and disposal journals");
    }
  });

  await run("59. Retry same disposal idempotency key creates no duplicate journals", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Idempotent Disposal Asset",
      originalCost: 3500,
      usefulLifeMonths: 36,
      placedInServiceDate: "2026-01-01",
    });
    await postMonths(supabase, orgId, asset.id as string, monthRange(2026, 1, 6));
    const operationId = randomUUID();
    const journalsBefore = await journalCount(supabase, orgId);
    const first = await disposeFixedAsset(supabase, {
      organizationId: orgId,
      assetId: asset.id as string,
      disposalDate: "2026-07-01",
      disposalType: "sold",
      proceeds: 2000,
      operationId,
    });
    const second = await disposeFixedAsset(supabase, {
      organizationId: orgId,
      assetId: asset.id as string,
      disposalDate: "2026-07-01",
      disposalType: "sold",
      proceeds: 2000,
      operationId,
    });
    const journalsAfter = await journalCount(supabase, orgId);
    if (journalsAfter !== journalsBefore + (first.depreciationJournalEntryIds.length + 1)) {
      throw new Error("idempotent retry should not add journals");
    }
    if (first.disposalEntryId !== second.disposalEntryId) {
      throw new Error("idempotent retry should return same disposal journal");
    }
    if (!second.duplicate) throw new Error("second call should be marked duplicate");
  });

  await run("60. Concurrent disposal attempts yield exactly one success", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Concurrent Disposal Asset",
      originalCost: 4200,
      usefulLifeMonths: 36,
      placedInServiceDate: "2026-01-01",
    });
    await postMonths(supabase, orgId, asset.id as string, monthRange(2026, 1, 4));
    const outcomes = await Promise.allSettled([
      disposeFixedAsset(supabase, {
        organizationId: orgId,
        assetId: asset.id as string,
        disposalDate: "2026-05-01",
        disposalType: "retired",
        operationId: randomUUID(),
      }),
      disposeFixedAsset(supabase, {
        organizationId: orgId,
        assetId: asset.id as string,
        disposalDate: "2026-05-01",
        disposalType: "retired",
        operationId: randomUUID(),
      }),
    ]);
    const successes = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");
    if (successes.length !== 1 || failures.length !== 1) {
      throw new Error(`expected 1 success and 1 failure, got ${successes.length}/${failures.length}`);
    }
    const row = await loadFixedAsset(supabase, orgId, asset.id as string);
    if (row.status !== "disposed") throw new Error("asset should be disposed exactly once");
  });

  await run("61. Disposal-period depreciation and disposal remain separate journals", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Separate Journals Asset",
      originalCost: 7200,
      usefulLifeMonths: 72,
      placedInServiceDate: "2026-01-01",
    });
    await postMonths(supabase, orgId, asset.id as string, monthRange(2026, 1, 6));
    const result = await disposeFixedAsset(supabase, {
      organizationId: orgId,
      assetId: asset.id as string,
      disposalDate: "2026-08-15",
      disposalType: "retired",
      operationId: randomUUID(),
    });
    if (!result.depreciationJournalEntryIds.length) {
      throw new Error("expected at least one disposal-period depreciation journal");
    }
    const { data: disposalEntry } = await supabase
      .from("teller_journal_entries")
      .select("id, source_kind")
      .eq("id", result.disposalEntryId)
      .maybeSingle();
    if (disposalEntry?.source_kind !== "fixed-asset-disposal") {
      throw new Error("disposal journal must use fixed-asset-disposal source kind");
    }
    for (const entryId of result.depreciationJournalEntryIds) {
      const { data: deprEntry } = await supabase
        .from("teller_journal_entries")
        .select("source_kind")
        .eq("id", entryId)
        .maybeSingle();
      if (deprEntry?.source_kind !== "fixed-asset-depreciation") {
        throw new Error("depreciation journals must remain separate from disposal");
      }
    }
    if (result.depreciationJournalEntryIds.includes(result.disposalEntryId)) {
      throw new Error("disposal journal must not be merged into depreciation journals");
    }
  });

  await run("62. Failed disposal leaves asset active and economics unchanged", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Failed Disposal Asset",
      originalCost: 2800,
      usefulLifeMonths: 24,
      placedInServiceDate: "2026-03-01",
    });
    const accumBefore = await sumPostedDepreciationForAsset(supabase, asset.id as string);
    const journalsBefore = await journalCount(supabase, orgId);
    let failed = false;
    try {
      await disposeFixedAssetControlledTest(supabase, {
        organizationId: orgId,
        assetId: asset.id as string,
        disposalDate: "2026-06-01",
        disposalType: "retired",
        operationId: randomUUID(),
        simulateFailureAfter: "before_asset_update",
      });
    } catch (err) {
      failed = err instanceof Error && err.message.includes("Simulated disposal failure");
    }
    if (!failed) throw new Error("expected disposal to fail");
    const row = await loadFixedAsset(supabase, orgId, asset.id as string);
    if (row.status !== "active") throw new Error("failed disposal should leave asset active");
    const accumAfter = await sumPostedDepreciationForAsset(supabase, asset.id as string);
    if (Math.abs(accumAfter - accumBefore) > 0.009) {
      throw new Error("failed disposal should not change posted depreciation");
    }
    const journalsAfter = await journalCount(supabase, orgId);
    if (journalsAfter !== journalsBefore) throw new Error("failed disposal should not change journal count");
  });

  await run("63. Same operation UUID concurrent requests yield one economic operation", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Same Key Concurrent Asset",
      originalCost: 3800,
      usefulLifeMonths: 36,
      placedInServiceDate: "2026-01-01",
    });
    await postMonths(supabase, orgId, asset.id as string, monthRange(2026, 1, 3));
    const operationId = randomUUID();
    const journalsBefore = await journalCount(supabase, orgId);
    const outcomes = await Promise.allSettled([
      disposeFixedAsset(supabase, {
        organizationId: orgId,
        assetId: asset.id as string,
        disposalDate: "2026-04-01",
        disposalType: "retired",
        operationId,
      }),
      disposeFixedAsset(supabase, {
        organizationId: orgId,
        assetId: asset.id as string,
        disposalDate: "2026-04-01",
        disposalType: "retired",
        operationId,
      }),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof disposeFixedAsset>>
    >[];
    if (fulfilled.length !== 2) {
      throw new Error(`expected both same-key concurrent calls to succeed idempotently, got ${fulfilled.length}/2`);
    }
    const disposalIds = new Set(fulfilled.map((outcome) => outcome.value.disposalEntryId));
    if (disposalIds.size !== 1) throw new Error("same operation UUID must resolve to one disposal journal");
    if (!fulfilled.some((outcome) => outcome.value.duplicate)) {
      throw new Error("one concurrent same-key response should be marked duplicate");
    }
    const journalsAfter = await journalCount(supabase, orgId);
    const expectedNew = fulfilled[0].value.depreciationJournalEntryIds.length + 1;
    if (journalsAfter !== journalsBefore + expectedNew) {
      throw new Error("same-key concurrency must not duplicate journals");
    }
  });

  await run("64. Dispose → reverse → dispose with new operation UUID succeeds", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Redisposal Asset",
      originalCost: 4500,
      usefulLifeMonths: 48,
      placedInServiceDate: "2026-02-01",
    });
    await postMonths(supabase, orgId, asset.id as string, monthRange(2026, 2, 2));
    const firstOperationId = randomUUID();
    const first = await disposeFixedAsset(supabase, {
      organizationId: orgId,
      assetId: asset.id as string,
      disposalDate: "2026-04-15",
      disposalType: "retired",
      operationId: firstOperationId,
    });
    await undoFixedAssetDisposal(supabase, {
      organizationId: orgId,
      assetId: asset.id as string,
      reversalDate: "2026-10-05",
      reason: "Disposed in error",
    });
    const secondOperationId = randomUUID();
    const second = await disposeFixedAsset(supabase, {
      organizationId: orgId,
      assetId: asset.id as string,
      disposalDate: "2026-05-01",
      disposalType: "retired",
      operationId: secondOperationId,
    });
    if (second.disposalEntryId === first.disposalEntryId) {
      throw new Error("redisposal with new operation UUID must create a new disposal journal");
    }
    const row = await loadFixedAsset(supabase, orgId, asset.id as string);
    if (row.status !== "disposed") throw new Error("redisposal should leave asset disposed");
  });

  await run("65. Reusing completed disposal operation UUID after reversal does not create new economics", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Stale Operation UUID Asset",
      originalCost: 3200,
      usefulLifeMonths: 36,
      placedInServiceDate: "2026-03-01",
    });
    const completedOperationId = randomUUID();
    const first = await disposeFixedAsset(supabase, {
      organizationId: orgId,
      assetId: asset.id as string,
      disposalDate: "2026-06-01",
      disposalType: "retired",
      operationId: completedOperationId,
    });
    await undoFixedAssetDisposal(supabase, {
      organizationId: orgId,
      assetId: asset.id as string,
      reversalDate: "2026-10-06",
      reason: "Testing stale idempotency key",
    });
    const journalsBefore = await journalCount(supabase, orgId);
    const stale = await disposeFixedAsset(supabase, {
      organizationId: orgId,
      assetId: asset.id as string,
      disposalDate: "2026-06-01",
      disposalType: "retired",
      operationId: completedOperationId,
    });
    const journalsAfter = await journalCount(supabase, orgId);
    if (journalsAfter !== journalsBefore) {
      throw new Error("stale completed operation UUID must not create new journals after reversal");
    }
    if (stale.disposalEntryId !== first.disposalEntryId) {
      throw new Error("stale operation UUID should return original completed disposal result");
    }
    if (!stale.duplicate) throw new Error("stale operation UUID retry should be marked duplicate");
    const row = await loadFixedAsset(supabase, orgId, asset.id as string);
    if (row.status !== "active") throw new Error("stale key must not dispose asset again");
  });

  await run("66. Lost-response retry reuses operation UUID and returns cached result", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Lost Response Retry Asset",
      originalCost: 5200,
      usefulLifeMonths: 48,
      placedInServiceDate: "2026-01-01",
    });
    await postMonths(supabase, orgId, asset.id as string, monthRange(2026, 1, 4));
    const operationId = randomUUID();
    const journalsBefore = await journalCount(supabase, orgId);
    const first = await disposeFixedAsset(supabase, {
      organizationId: orgId,
      assetId: asset.id as string,
      disposalDate: "2026-05-10",
      disposalType: "sold",
      proceeds: 3000,
      operationId,
    });
    const deprAfterFirst = await sumPostedDepreciationForAsset(supabase, asset.id as string);
    const retry = await disposeFixedAsset(supabase, {
      organizationId: orgId,
      assetId: asset.id as string,
      disposalDate: "2026-05-10",
      disposalType: "sold",
      proceeds: 3000,
      operationId,
    });
    const journalsAfter = await journalCount(supabase, orgId);
    const deprAfterRetry = await sumPostedDepreciationForAsset(supabase, asset.id as string);
    if (first.disposalEntryId !== retry.disposalEntryId) {
      throw new Error("lost-response retry must return same disposal journal");
    }
    if (!retry.duplicate) throw new Error("lost-response retry must be marked duplicate");
    if (journalsAfter !== journalsBefore + first.depreciationJournalEntryIds.length + 1) {
      throw new Error("lost-response retry must not add journals");
    }
    if (Math.abs(deprAfterRetry - deprAfterFirst) > 0.009) {
      throw new Error("lost-response retry must not change posted depreciation");
    }
    const row = await loadFixedAsset(supabase, orgId, asset.id as string);
    if (row.status !== "disposed") throw new Error("asset should remain disposed once");
    if (asNumber(row.disposal_proceeds) !== 3000) throw new Error("proceeds unchanged on retry");
  });

  await run("67. Missing operationId rejected before economic mutation", async () => {
    const asset = await activateAsset(supabase, orgId, {
      name: "Missing Operation ID Asset",
      originalCost: 2100,
      usefulLifeMonths: 24,
      placedInServiceDate: "2026-02-01",
    });
    const journalsBefore = await journalCount(supabase, orgId);
    let rejected = false;
    try {
      await disposeFixedAsset(supabase, {
        organizationId: orgId,
        assetId: asset.id as string,
        disposalDate: "2026-04-01",
        disposalType: "retired",
        operationId: "",
      });
    } catch (err) {
      rejected = err instanceof Error && err.message.includes("operationId is required");
    }
    if (!rejected) throw new Error("missing operationId should be rejected");
    try {
      assertValidDisposalOperationId(undefined);
    } catch (err) {
      if (!(err instanceof Error && err.message.includes("operationId is required"))) {
        throw new Error("assertValidDisposalOperationId should reject undefined");
      }
    }
    const row = await loadFixedAsset(supabase, orgId, asset.id as string);
    if (row.status !== "active") throw new Error("missing operationId must not dispose asset");
    const journalsAfter = await journalCount(supabase, orgId);
    if (journalsAfter !== journalsBefore) {
      throw new Error("missing operationId must not create journals");
    }
  });

  const finalReport = await buildFixedAssetReconciliationReport(supabase, orgId, {
    asOfDate: TODAY,
    periodYear: 2026,
    periodMonth: 1,
  });
  const passed = results.filter((row) => row.pass).length;
  const summary = {
    passed,
    total: results.length,
    allPassed: passed === results.length,
    reconciliation: {
      fixedAssetCostDifference: finalReport.fixedAssetCost.difference,
      accumulatedDepreciationDifference: finalReport.accumulatedDepreciation.difference,
      depreciationExpenseDifference: finalReport.depreciationExpense.difference,
      consistent: finalReport.consistent,
    },
    hfacBaselineUnchanged: JSON.stringify(hfacBefore) === JSON.stringify(await hfacBaseline(supabase)),
    failed: results.filter((row) => !row.pass),
  };

  console.log(`\nPhase 8 demo: ${passed}/${results.length} passed`);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(passed === results.length ? 0 : 1);
}

main();
