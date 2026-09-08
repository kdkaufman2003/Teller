import { describe, expect, it } from "vitest";
import {
  applyWeightedAverageReceipt,
  applyWeightedAverageIssue,
  applyJobReturnAtCost,
  applyTransferOut,
  applyTransferIn,
  reconcileQuantityBridge,
} from "./inventory/valuation";
import {
  buildInventoryReceiptJournalLines,
  buildInventoryIssueJournalLines,
  buildInventoryJobReturnJournalLines,
  buildInventoryDecreaseJournalLines,
  buildInventoryIncreaseJournalLines,
  buildOpeningInventoryJournalLines,
  assertInventoryJournalBalanced,
  reverseInventoryJournalLines,
} from "./inventory/journal-lines";
import {
  reconcileInventorySubledgerToGl,
  reconcileInventoryCogs,
  reconcileTransferZeroGl,
} from "./inventory/reconciliation";
import {
  buildInventoryValuationSummary,
  buildJobMaterialUsageReport,
  OWNER_MODE_INVENTORY_LABELS,
  ACCOUNTANT_MODE_INVENTORY_LABELS,
} from "./inventory/reporting";
import { evaluateInventoryCloseFindings } from "./inventory/close-integration";
import {
  assertHfacInventoryHardRefusal,
  hfacInventoryIntegrationAllowed,
} from "./inventory/hfac-boundary";
import {
  buildGrniBillSettlementJournalLines,
  buildGrniMatchedBillJournalPreview,
  buildGrniReceiptJournalPreview,
  validateInventoryBillEconomics,
  partitionBillLines,
} from "./inventory/bill-integration";
import {
  buildGrniReceiptJournalLines,
  buildGrniBillSettlementJournalLines as buildGrniBillSettlementLines,
  buildUnbilledVendorReturnJournalLines,
  assertSameDayNetEconomics,
  GRNI_PPV_POLICY_V1,
} from "./inventory/grni/journal-lines";
import {
  resolveReceiptUnitCost,
  computeReceiptExtendedCost,
} from "./inventory/grni/receipt-cost";
import {
  previewBillSettlement,
  applySettlementToReceiptState,
  canReverseReceipt,
  assertMatchCapacity,
  computeOpenReceiptQuantity,
  type ReceiptOpenState,
} from "./inventory/grni/settlement";
import {
  reconcileGrniSubledgerToGl,
  assertGrniReconciliationZero,
} from "./inventory/grni/reconciliation";
import {
  buildPurchasePriceVarianceReport,
  buildGrniAgingReport,
  buildAccountantGrniPackage,
} from "./inventory/grni/reporting";
import { evaluateGrniCloseFindings } from "./inventory/grni/close-integration";
import { validateInventoryAccountMappings } from "./inventory/grni/mappings";
import {
  buildInventoryVendorReturnJournalLines,
} from "./inventory/journal-lines";
import {
  assertSufficientStock,
  PHASE13_RECEIPT_ACCOUNTING_MODEL,
} from "./inventory/types";
import { TELLER_HFAC_ORG_ID } from "@/lib/integration/controlled-prod-test";
import {
  computeActualDirectCostBreakdown,
  computeInventoryMaterialCost,
} from "./job-profitability";

const INVENTORY = "inventory-asset";
const AP = "ap";
const COGS = "cogs";
const GRNI = "grni";
const PPV = "ppv";
const SHRINK = "shrink";
const GAIN = "gain";
const OBE = "obe";

describe("Phase 13 weighted average valuation", () => {
  it("computes first receipt weighted average", () => {
    const result = applyWeightedAverageReceipt(
      { quantityOnHand: 0, inventoryValue: 0, weightedAverageUnitCost: 0 },
      10,
      100,
    );
    expect(result.quantityOnHand).toBe(10);
    expect(result.inventoryValue).toBe(1000);
    expect(result.weightedAverageUnitCost).toBe(100);
  });

  it("computes second receipt weighted average", () => {
    const first = applyWeightedAverageReceipt(
      { quantityOnHand: 0, inventoryValue: 0, weightedAverageUnitCost: 0 },
      10,
      100,
    );
    const second = applyWeightedAverageReceipt(first, 10, 120);
    expect(second.quantityOnHand).toBe(20);
    expect(second.inventoryValue).toBe(2200);
    expect(second.weightedAverageUnitCost).toBe(110);
  });

  it("issues at weighted average and computes COGS", () => {
    const state = applyWeightedAverageReceipt(
      { quantityOnHand: 0, inventoryValue: 0, weightedAverageUnitCost: 0 },
      20,
      110,
    );
    const issue = applyWeightedAverageIssue(state, 5);
    expect(issue.cogsAmount).toBe(550);
    expect(issue.quantityOnHand).toBe(15);
    expect(issue.inventoryValue).toBe(1650);
  });

  it("rejects insufficient stock", () => {
    const state = { quantityOnHand: 2, inventoryValue: 200, weightedAverageUnitCost: 100 };
    expect(() => applyWeightedAverageIssue(state, 3)).toThrow(/Insufficient/);
  });

  it("returns job material at original issue cost", () => {
    const state = applyWeightedAverageReceipt(
      { quantityOnHand: 0, inventoryValue: 0, weightedAverageUnitCost: 0 },
      10,
      100,
    );
    const afterIssue = applyWeightedAverageIssue(state, 5);
    const afterReturn = applyJobReturnAtCost(afterIssue, 2, 100);
    expect(afterReturn.quantityOnHand).toBe(7);
    expect(afterReturn.inventoryValue).toBe(700);
  });

  it("transfer preserves total quantity and value", () => {
    const state = applyWeightedAverageReceipt(
      { quantityOnHand: 0, inventoryValue: 0, weightedAverageUnitCost: 0 },
      10,
      100,
    );
    const out = applyTransferOut(state, 4);
    const dest = applyTransferIn(
      { quantityOnHand: 0, inventoryValue: 0, weightedAverageUnitCost: 0 },
      4,
      out.extendedCost / 4,
    );
    expect(out.quantityOnHand + dest.quantityOnHand).toBe(10);
    expect(out.inventoryValue + dest.inventoryValue).toBe(1000);
  });
});

describe("Phase 13 inventory journals", () => {
  it("builds balanced receipt journal Dr Inventory / Cr AP", () => {
    const lines = buildInventoryReceiptJournalLines({
      amount: 500,
      inventoryAssetAccountId: INVENTORY,
      accountsPayableAccountId: AP,
    });
    expect(() => assertInventoryJournalBalanced(lines)).not.toThrow();
    expect(lines[0]!.debit).toBe(500);
    expect(lines[1]!.credit).toBe(500);
  });

  it("builds balanced job issue journal", () => {
    const lines = buildInventoryIssueJournalLines({
      amount: 250,
      cogsAccountId: COGS,
      inventoryAssetAccountId: INVENTORY,
      jobId: "job-1",
    });
    expect(() => assertInventoryJournalBalanced(lines)).not.toThrow();
    expect(lines[0]!.jobId).toBe("job-1");
  });

  it("builds balanced job return journal", () => {
    const lines = buildInventoryJobReturnJournalLines({
      amount: 100,
      cogsAccountId: COGS,
      inventoryAssetAccountId: INVENTORY,
      jobId: "job-1",
    });
    expect(() => assertInventoryJournalBalanced(lines)).not.toThrow();
  });

  it("reverses inventory journal lines", () => {
    const lines = buildInventoryDecreaseJournalLines({
      amount: 50,
      adjustmentExpenseAccountId: SHRINK,
      inventoryAssetAccountId: INVENTORY,
    });
    const reversed = reverseInventoryJournalLines(lines);
    expect(reversed[0]!.credit).toBe(50);
  });
});

describe("Phase 13 reconciliation", () => {
  it("ties subledger to GL", () => {
    const result = reconcileInventorySubledgerToGl({
      balances: [
        { quantityOnHand: 10, inventoryValue: 1000, weightedAverageUnitCost: 100 },
        { quantityOnHand: 5, inventoryValue: 550, weightedAverageUnitCost: 110 },
      ],
      glInventoryAssetBalance: 1550,
    });
    expect(result.difference).toBe(0);
  });

  it("reconciles COGS from issues", () => {
    expect(reconcileInventoryCogs({ issueCosts: [250, 100], cogsGlActivity: 350 })).toBe(0);
  });

  it("transfer has zero GL net effect", () => {
    expect(
      reconcileTransferZeroGl({ transferOutValue: 400, transferInValue: 400, glNetChange: 0 }),
    ).toBe(0);
  });
});

describe("Phase 13 job costing integration", () => {
  it("computes inventory material cost without double-counting purchases", () => {
    const cost = computeInventoryMaterialCost(
      [
        { jobId: "j1", movementType: "job_issue", extendedCost: 300 },
        { jobId: "j1", movementType: "job_return", extendedCost: 50 },
      ],
      "j1",
    );
    expect(cost).toBe(250);
  });

  it("breaks down actual direct cost", () => {
    const breakdown = computeActualDirectCostBreakdown({
      journalDirectCost: 400,
      inventoryMaterialCost: 250,
      directLaborCost: 1000,
      employerLaborBurden: 76.5,
    });
    expect(breakdown.directMaterialCost).toBe(250);
    expect(breakdown.otherDirectCost).toBe(150);
    expect(breakdown.actualDirectCost).toBe(1476.5);
  });
});

describe("Phase 13 GRNI bill integration", () => {
  it("uses GRNI receipt and bill settlement model", () => {
    expect(PHASE13_RECEIPT_ACCOUNTING_MODEL).toContain("grni");
  });

  it("builds receipt journal Dr Inventory / Cr GRNI", () => {
    const lines = buildGrniReceiptJournalLines({
      amount: 1000,
      inventoryAssetAccountId: INVENTORY,
      grniAccountId: GRNI,
    });
    expect(() => assertInventoryJournalBalanced(lines)).not.toThrow();
    expect(lines[0]!.debit).toBe(1000);
    expect(lines[1]!.accountId).toBe(GRNI);
  });

  it("builds bill settlement Dr GRNI / Dr PPV / Cr AP for positive variance", () => {
    const lines = buildGrniBillSettlementLines({
      grniAmount: 1000,
      billAmount: 1050,
      grniAccountId: GRNI,
      accountsPayableAccountId: AP,
      purchasePriceVarianceAccountId: PPV,
    });
    expect(() => assertInventoryJournalBalanced(lines)).not.toThrow();
  });

  it("matched bill preview does not debit inventory again", () => {
    const preview = buildGrniMatchedBillJournalPreview({
      settlements: [
        {
          receiptLineId: "rl1",
          billLineId: "bl1",
          quantityMatched: 10,
          receiptUnitCost: 100,
          billUnitCost: 100,
        },
      ],
      inventoryAssetAccountId: INVENTORY,
      grniAccountId: GRNI,
      accountsPayableAccountId: AP,
      purchasePriceVarianceAccountId: PPV,
    });
    expect(preview.lines.some((row) => row.accountId === INVENTORY && row.debit > 0)).toBe(false);
  });

  it("partitions GRNI matched inventory bill lines", () => {
    const { grniMatchedInventoryLines, expenseLines, unmatchedInventoryLines } = partitionBillLines([
      { amount: 100, account_id: COGS, description: "expense", item_type: "expense" },
      {
        amount: 200,
        account_id: INVENTORY,
        description: "part",
        item_type: "inventory",
        inventory_item_id: "item-1",
        inventory_location_id: "loc-1",
        receipt_line_id: "rl1",
        receipt_match_quantity: 2,
        quantity: 2,
        unit_cost: 100,
      },
    ]);
    expect(grniMatchedInventoryLines).toHaveLength(1);
    expect(expenseLines).toHaveLength(1);
    expect(unmatchedInventoryLines).toHaveLength(0);
  });

  it("blocks unmatched inventory bill lines", () => {
    expect(() =>
      validateInventoryBillEconomics([
        {
          amount: 200,
          account_id: INVENTORY,
          description: "part",
          item_type: "inventory",
          inventory_item_id: "item-1",
          inventory_location_id: "loc-1",
        },
      ]),
    ).toThrow(/receipt match/);
  });

  it("blocks receipt without valid cost", () => {
    expect(() => resolveReceiptUnitCost({})).toThrow(/valid unit cost/);
  });

  it("reconciles GRNI subledger to GL", () => {
    const result = reconcileGrniSubledgerToGl({
      receipts: [
        {
          receiptLineId: "rl1",
          quantityReceived: 10,
          quantityMatched: 0,
          receiptValue: 1000,
          valueMatched: 0,
        },
      ],
      grniGlBalance: 1000,
    });
    assertGrniReconciliationZero(result);
  });

  it("consume before bill keeps job material cost separate", () => {
    const issue = applyWeightedAverageIssue(
      applyWeightedAverageReceipt({ quantityOnHand: 0, inventoryValue: 0, weightedAverageUnitCost: 0 }, 10, 100),
      4,
    );
    const material = computeInventoryMaterialCost(
      [{ jobId: "j1", movementType: "job_issue", extendedCost: issue.cogsAmount }],
      "j1",
    );
    expect(material).toBe(400);
    void buildGrniBillSettlementLines({
      grniAmount: 1000,
      billAmount: 1050,
      grniAccountId: GRNI,
      accountsPayableAccountId: AP,
      purchasePriceVarianceAccountId: PPV,
    });
  });

  it("unbilled vendor return Dr GRNI / Cr Inventory", () => {
    const lines = buildUnbilledVendorReturnJournalLines({
      amount: 200,
      grniAccountId: GRNI,
      inventoryAssetAccountId: INVENTORY,
    });
    expect(() => assertInventoryJournalBalanced(lines)).not.toThrow();
  });
});

describe("Phase 13 security and boundaries", () => {
  it("refuses HFAC inventory integration", () => {
    expect(hfacInventoryIntegrationAllowed()).toBe(false);
    expect(() => assertHfacInventoryHardRefusal(TELLER_HFAC_ORG_ID)).toThrow(/HFAC/);
  });

  it("blocks insufficient stock assertion", () => {
    expect(() => assertSufficientStock(3, 5)).toThrow(/Insufficient/);
  });
});

describe("Phase 13 reporting and close", () => {
  it("builds valuation summary", () => {
    const rows = buildInventoryValuationSummary(
      [{ id: "i1", sku: "SKU-1", name: "Filter" }],
      [{ inventoryItemId: "i1", quantityOnHand: 10, inventoryValue: 1000, weightedAverageUnitCost: 100 }],
    );
    expect(rows[0]!.totalValue).toBe(1000);
  });

  it("evaluates inventory close blockers", () => {
    const findings = evaluateInventoryCloseFindings({
      glDifference: 10,
      negativeRows: [{ sku: "A", quantityOnHand: -1 }],
      allowNegative: false,
      unvaluedCount: 1,
      brokenTransfers: 1,
      totalSubledgerValue: 1000,
    });
    expect(findings.some((row) => row.severity === "blocker")).toBe(true);
  });

  it("exposes owner and accountant labels", () => {
    expect(OWNER_MODE_INVENTORY_LABELS.inventoryValue).toBe("Inventory Value");
    expect(ACCOUNTANT_MODE_INVENTORY_LABELS.weightedAverageCost).toBe("Weighted Average Cost");
  });
});
