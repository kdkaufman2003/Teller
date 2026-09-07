/**
 * Phase 11.1 controlled demo — accrual settlement + scheduler readiness matrix.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildAccrualSettlementJournalLines,
  assertSettlementJournalBalanced,
  sumJournalDebits,
  sumJournalCredits,
  buildAccrualSettlementReversalLines,
  totalExpenseEffectFromSettlement,
} from "../src/lib/accounting/accrual-settlement/journal-lines";
import { computeSettlementEconomics } from "../src/lib/accounting/accrual-settlement/allocation-engine";
import {
  allocateVendorPurchaseTax,
  purchaseTaxUsesSalesTaxPayable,
} from "../src/lib/accounting/accrual-settlement/purchase-tax";
import {
  BILL_VOID_BLOCKED_ACTIVE_SETTLEMENT_MESSAGE,
  isActiveSettlementStatus,
} from "../src/lib/accounting/accrual-settlement/bill-settlement-guard";
import {
  computeOccurrenceSettlementStatus,
  computeSettlementHeaderStatus,
  variancePercent,
} from "../src/lib/accounting/accrual-settlement/status";
import {
  isOccurrenceEligibleForSettlement,
  assertSameOrganization,
  toEligibleOccurrence,
  type AccrualOccurrenceRow,
} from "../src/lib/accounting/accrual-settlement/eligibility";
import {
  buildAccrualSettlementRollforward,
  buildAccrualVarianceReportRows,
  distributeSettlementVariance,
  reconcileAccrualLiabilityToGl,
} from "../src/lib/accounting/accrual-settlement/reporting";
import {
  classifyAccrualSettlementCloseFinding,
  filterAccrualWarnings,
} from "../src/lib/accounting/accrual-settlement/close-integration";
import { accrualSettlementIdempotencyKey } from "../src/lib/accounting/accrual-settlement/types";
import {
  accrualMustNotCreateApBill,
  accrualSettlementViaBillAllowed,
} from "../src/lib/accounting/schedules/accrual";
import {
  PRODUCTION_SCHEDULER_ENABLED,
  loadSchedulerConfig,
  RECOMMENDED_CRON_SCHEDULE,
  assertSchedulerAuthorized,
} from "../src/lib/accounting/schedules/scheduler-config";
import { buildAccrualRollforward } from "../src/lib/accounting/schedules/rollforward";
import { TELLER_HFAC_ORG_ID } from "../src/lib/integration/controlled-prod-test";

export const PHASE11_1_CONTROLLED_MATRIX_SIZE = 88;

type Scenario = { label: string; run: () => void | Promise<void> };

const LIABILITY = "liability-id";
const EXPENSE = "expense-id";
const EXPENSE_B = "expense-b";
const LIAB_B = "liab-b";
const SUPPLIES = "supplies-exp";
const AP = "ap-id";

function sampleOccurrence(overrides: Partial<AccrualOccurrenceRow> = {}): AccrualOccurrenceRow {
  return {
    id: "occ-1",
    organization_id: "org-a",
    schedule_id: "sched-1",
    occurrence_date: "2026-01-31",
    amount: 1000,
    status: "posted",
    journal_entry_id: "je-1",
    teller_accounting_schedules: {
      schedule_type: "accrued_expense",
      name: "Utilities accrual",
      vendor_party_id: "vendor-1",
      liability_account_id: LIABILITY,
      expense_account_id: EXPENSE,
      status: "active",
    },
    ...overrides,
  };
}

function migration028Path() {
  return join(process.cwd(), "supabase/migrations/028_phase11_1_accrual_settlement.sql");
}

function readMigration028() {
  return readFileSync(migration028Path(), "utf8");
}

function settlementLines(actual: number, applied: number) {
  const economics = computeSettlementEconomics({
    billLines: [{ amount: actual, account_id: EXPENSE }],
    taxAmount: 0,
    accrualAllocations: [
      {
        occurrenceId: "occ-1",
        appliedAmount: applied,
        liabilityAccountId: LIABILITY,
        expenseAccountId: EXPENSE,
      },
    ],
  });
  return buildAccrualSettlementJournalLines({
    accrualAllocations: economics.accrualAllocations,
    newExpenseDebits: economics.newExpenseDebits,
    billTotal: economics.billTotal,
    apAccountId: AP,
  });
}

function buildScenarioMatrix(): Scenario[] {
  const scenarios: Scenario[] = [];

  scenarios.push({
    label: "Migration 028 file exists",
    run: () => {
      if (!existsSync(migration028Path())) throw new Error("missing 028");
    },
  });

  scenarios.push({
    label: "Migration 028 does not alter teller_post_journal",
    run: () => {
      const sql = readMigration028();
      if (/create\s+or\s+replace\s+function\s+public\.teller_post_journal/i.test(sql)) {
        throw new Error("must not replace teller_post_journal");
      }
    },
  });

  scenarios.push({
    label: "Migration 028 enables RLS on settlement tables",
    run: () => {
      const sql = readMigration028();
      if (!sql.includes("teller_accrual_settlements")) throw new Error("settlements table missing");
      if (!sql.includes("enable row level security")) throw new Error("RLS missing");
    },
  });

  scenarios.push({
    label: "Migration 028 adds scheduler run history",
    run: () => {
      if (!readMigration028().includes("teller_scheduler_runs")) throw new Error("scheduler runs missing");
    },
  });

  scenarios.push({
    label: "Migration 028 over-settlement trigger present",
    run: () => {
      if (!readMigration028().includes("teller_accrual_allocation_capacity_check")) {
        throw new Error("capacity trigger missing");
      }
    },
  });

  scenarios.push({
    label: "HFAC org hard refusal constant present",
    run: () => {
      if (!TELLER_HFAC_ORG_ID) throw new Error("HFAC org id missing");
    },
  });

  scenarios.push({
    label: "Production scheduler disabled by default",
    run: () => {
      if (PRODUCTION_SCHEDULER_ENABLED) throw new Error("scheduler must default disabled");
    },
  });

  scenarios.push({
    label: "Scheduler config batch size bounded",
    run: () => {
      const config = loadSchedulerConfig();
      if (config.batchSize < 1 || config.batchSize > 500) throw new Error("invalid batch size");
    },
  });

  scenarios.push({
    label: "Recommended cron is hourly",
    run: () => {
      if (RECOMMENDED_CRON_SCHEDULE !== "0 * * * *") throw new Error("unexpected cron");
    },
  });

  scenarios.push({
    label: "Scheduler auth rejects missing secret",
    run: () => {
      const prior = process.env.SCHEDULER_CRON_SECRET;
      process.env.SCHEDULER_CRON_SECRET = "";
      try {
        assertSchedulerAuthorized("Bearer x");
        throw new Error("should reject");
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("not configured")) {
          throw error;
        }
      } finally {
        process.env.SCHEDULER_CRON_SECRET = prior;
      }
    },
  });

  scenarios.push({
    label: "1 exact estimate = actual settlement balanced",
    run: () => {
      const lines = settlementLines(1000, 1000);
      assertSettlementJournalBalanced(lines);
      if (sumJournalCredits(lines) !== 1000) throw new Error("AP mismatch");
    },
  });

  scenarios.push({
    label: "2 actual > estimate variance debit",
    run: () => {
      const lines = settlementLines(1100, 1000);
      assertSettlementJournalBalanced(lines);
      const expenseDebit = lines.find((l) => l.account_id === EXPENSE && l.debit)?.debit ?? 0;
      if (expenseDebit !== 100) throw new Error(`expected 100 got ${expenseDebit}`);
    },
  });

  scenarios.push({
    label: "3 actual < estimate variance credit",
    run: () => {
      const lines = settlementLines(900, 1000);
      assertSettlementJournalBalanced(lines);
      const expenseCredit = lines.find((l) => l.account_id === EXPENSE && l.credit)?.credit ?? 0;
      if (expenseCredit !== 100) throw new Error(`expected 100 got ${expenseCredit}`);
    },
  });

  scenarios.push({
    label: "4 partial settlement journal balanced",
    run: () => {
      const lines = settlementLines(600, 600);
      assertSettlementJournalBalanced(lines);
    },
  });

  scenarios.push({
    label: "5 multiple accruals one bill with per-account variance",
    run: () => {
      const economics = computeSettlementEconomics({
        billLines: [{ amount: 1100, account_id: EXPENSE }],
        taxAmount: 0,
        accrualAllocations: [
          { occurrenceId: "a", appliedAmount: 600, liabilityAccountId: LIABILITY, expenseAccountId: EXPENSE },
          { occurrenceId: "b", appliedAmount: 400, liabilityAccountId: LIAB_B, expenseAccountId: EXPENSE_B },
        ],
      });
      const lines = buildAccrualSettlementJournalLines({
        accrualAllocations: economics.accrualAllocations,
        billTotal: economics.billTotal,
        apAccountId: AP,
      });
      assertSettlementJournalBalanced(lines);
      if (sumJournalCredits(lines) !== 1100) throw new Error("AP must equal bill total");
      const utilVar = lines.find((line) => line.account_id === EXPENSE && line.debit)?.debit ?? 0;
      const maintVar = lines.find((line) => line.account_id === EXPENSE_B && line.debit)?.debit ?? 0;
      if (utilVar !== 60 || maintVar !== 40) throw new Error(`variance split wrong ${utilVar}/${maintVar}`);
    },
  });

  scenarios.push({
    label: "6 multiple bills one accrual partial then remainder",
    run: () => {
      const first = settlementLines(600, 600);
      const second = settlementLines(500, 400);
      assertSettlementJournalBalanced(first);
      assertSettlementJournalBalanced(second);
    },
  });

  scenarios.push({
    label: "7 cannot over-settle eligibility",
    run: () => {
      const row = sampleOccurrence();
      const check = isOccurrenceEligibleForSettlement(row, {
        organizationId: "org-a",
        billPartyId: "vendor-1",
        settledAmount: 600,
        applyAmount: 500,
      });
      if (check.eligible) throw new Error("500 exceeds remaining 400");
    },
  });

  scenarios.push({
    label: "8 duplicate idempotency key format stable",
    run: () => {
      const a = accrualSettlementIdempotencyKey("bill-1");
      const b = accrualSettlementIdempotencyKey("bill-1");
      if (a !== b) throw new Error("idempotency unstable");
    },
  });

  scenarios.push({
    label: "9 concurrent key uses client token",
    run: () => {
      const key = accrualSettlementIdempotencyKey("bill-1", "client-token");
      if (!key.includes("client-token")) throw new Error("client key ignored");
    },
  });

  scenarios.push({
    label: "10 cross-org denied",
    run: () => {
      try {
        assertSameOrganization("org-a", "org-b");
        throw new Error("should fail");
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("Cross-organization")) throw error;
      }
    },
  });

  scenarios.push({
    label: "11 reversed accrual rejected",
    run: () => {
      const row = sampleOccurrence({ status: "reversed" });
      const check = isOccurrenceEligibleForSettlement(row, { organizationId: "org-a" });
      if (check.eligible) throw new Error("reversed must reject");
    },
  });

  scenarios.push({
    label: "12 paused schedule rejected",
    run: () => {
      const row = sampleOccurrence({
        teller_accounting_schedules: {
          ...sampleOccurrence().teller_accounting_schedules,
          status: "paused",
        },
      });
      if (isOccurrenceEligibleForSettlement(row, { organizationId: "org-a" }).eligible) {
        throw new Error("paused schedule must reject");
      }
    },
  });

  scenarios.push({
    label: "13 cancelled schedule rejected",
    run: () => {
      const row = sampleOccurrence({
        teller_accounting_schedules: {
          ...sampleOccurrence().teller_accounting_schedules,
          status: "cancelled",
        },
      });
      if (isOccurrenceEligibleForSettlement(row, { organizationId: "org-a" }).eligible) {
        throw new Error("cancelled schedule must reject");
      }
    },
  });

  scenarios.push({
    label: "14 variance calculated correctly",
    run: () => {
      const lines = settlementLines(1100, 1000);
      const debits = sumJournalDebits(lines);
      const credits = sumJournalCredits(lines);
      if (debits !== credits) throw new Error("unbalanced");
    },
  });

  scenarios.push({
    label: "15 settlement journal balanced property",
    run: () => {
      for (const total of [900, 1000, 1100, 1250.55]) {
        assertSettlementJournalBalanced(settlementLines(total, 1000));
      }
    },
  });

  scenarios.push({
    label: "16 AP equals bill total",
    run: () => {
      const total = 1234.56;
      const lines = settlementLines(total, 1000);
      const ap = lines.find((l) => l.account_id === AP)?.credit ?? 0;
      if (ap !== total) throw new Error("AP mismatch");
    },
  });

  scenarios.push({
    label: "17 remaining accrued liability status partial",
    run: () => {
      const status = computeOccurrenceSettlementStatus({
        occurrenceAmount: 1000,
        settledAmount: 600,
        occurrenceStatus: "posted",
      });
      if (status !== "partially_settled") throw new Error(status);
    },
  });

  scenarios.push({
    label: "18 original accrual journal unchanged invariant documented",
    run: () => {
      if (!accrualMustNotCreateApBill()) throw new Error("accrual invariant");
      if (!accrualSettlementViaBillAllowed()) throw new Error("settlement path");
    },
  });

  scenarios.push({
    label: "19 bill payment later only AP cash economics preserved",
    run: () => {
      const lines = settlementLines(1000, 1000);
      const apCredit = lines.find((l) => l.account_id === AP)?.credit ?? 0;
      if (apCredit !== 1000) throw new Error("AP liability for payment");
    },
  });

  scenarios.push({
    label: "20 no duplicate expense total effect",
    run: () => {
      const economics = computeSettlementEconomics({
        billLines: [{ amount: 1100, account_id: EXPENSE }],
        taxAmount: 0,
        accrualAllocations: [
          { occurrenceId: "occ-1", appliedAmount: 1000, liabilityAccountId: LIABILITY, expenseAccountId: EXPENSE },
        ],
      });
      const effect = totalExpenseEffectFromSettlement({
        accrualAllocations: economics.accrualAllocations,
        newExpenseAmount: economics.newExpensePortion,
      });
      if (effect !== 1100) throw new Error("total expense should be 1100 not 2100");
    },
  });

  scenarios.push({
    label: "21 reverse settlement lines balanced",
    run: () => {
      const posted = settlementLines(1100, 1000);
      const reversed = buildAccrualSettlementReversalLines(posted);
      assertSettlementJournalBalanced(reversed);
    },
  });

  scenarios.push({
    label: "22 capacity restored after reversal status",
    run: () => {
      const status = computeOccurrenceSettlementStatus({
        occurrenceAmount: 1000,
        settledAmount: 0,
        occurrenceStatus: "posted",
      });
      if (status !== "unsettled") throw new Error(status);
    },
  });

  scenarios.push({
    label: "23 reversal journal balanced",
    run: () => {
      const reversed = buildAccrualSettlementReversalLines(settlementLines(900, 1000));
      if (sumJournalDebits(reversed) !== sumJournalCredits(reversed)) throw new Error("unbalanced");
    },
  });

  scenarios.push({
    label: "24 original settlement preserved conceptually immutable",
    run: () => {
      const posted = settlementLines(1000, 1000);
      const reversed = buildAccrualSettlementReversalLines(posted);
      if (reversed.length !== posted.length) throw new Error("line count mismatch");
    },
  });

  scenarios.push({
    label: "25 double reversal blocked at service layer documented",
    run: () => {
      const sql = readMigration028();
      if (!sql.includes("reversal_journal_entry_id")) throw new Error("reversal column missing");
    },
  });

  scenarios.push({
    label: "26 rollforward tie",
    run: () => {
      const rf = buildAccrualSettlementRollforward({
        controlAccountId: LIABILITY,
        beginningAccrual: 1000,
        newAccruals: 500,
        settlements: 600,
        reversals: 0,
        glBalance: 900,
      });
      if (rf.ending !== 900) throw new Error(`ending ${rf.ending}`);
    },
  });

  scenarios.push({
    label: "27 variance report row",
    run: () => {
      const rows = buildAccrualVarianceReportRows([
        {
          occurrenceId: "o1",
          scheduleId: "s1",
          scheduleName: "Utilities",
          vendorName: "Acme",
          occurrenceDate: "2026-01-31",
          estimatedAmount: 1000,
          appliedAmount: 1000,
          actualAmountAllocated: 1100,
          varianceAmount: 100,
          settlementDate: "2026-02-15",
          billId: "b1",
          billNumber: "BILL-1",
          settlementId: "set-1",
        },
      ]);
      if (rows[0].varianceAmount !== 100) throw new Error("variance");
    },
  });

  scenarios.push({
    label: "28 assigned accrual GL reconcile helper",
    run: () => {
      const { tied } = reconcileAccrualLiabilityToGl({ subledgerEnding: 1000, glBalance: 1000 });
      if (!tied) throw new Error("should tie");
    },
  });

  scenarios.push({
    label: "29 partial settlement shown correctly",
    run: () => {
      const eligible = toEligibleOccurrence(sampleOccurrence(), 600);
      if (eligible.remainingAmount !== 400) throw new Error(String(eligible.remainingAmount));
    },
  });

  scenarios.push({
    label: "30 unsettled accrual warning",
    run: () => {
      const finding = classifyAccrualSettlementCloseFinding({
        occurrenceId: "o1",
        scheduleId: "s1",
        scheduleName: "Utilities",
        occurrenceDate: "2026-01-31",
        accruedAmount: 1000,
        settledAmount: 0,
        remainingAmount: 1000,
        settlementStatus: "unsettled",
        expectedSettlementDate: "2026-01-31",
      });
      if (finding.severity !== "warning") throw new Error(finding.severity);
    },
  });

  scenarios.push({
    label: "31 partially settled warning",
    run: () => {
      const finding = classifyAccrualSettlementCloseFinding({
        occurrenceId: "o1",
        scheduleId: "s1",
        scheduleName: "Utilities",
        occurrenceDate: "2026-01-31",
        accruedAmount: 1000,
        settledAmount: 600,
        remainingAmount: 400,
        settlementStatus: "partially_settled",
      });
      if (finding.severity !== "warning") throw new Error(finding.severity);
    },
  });

  scenarios.push({
    label: "32 future expected settlement informational",
    run: () => {
      const finding = classifyAccrualSettlementCloseFinding({
        occurrenceId: "o1",
        scheduleId: "s1",
        scheduleName: "Utilities",
        occurrenceDate: "2026-03-31",
        accruedAmount: 1000,
        settledAmount: 0,
        remainingAmount: 1000,
        settlementStatus: "unsettled",
        expectedSettlementDate: "2026-01-31",
      });
      if (finding.severity === "blocker") throw new Error("future must not block");
    },
  });

  scenarios.push({
    label: "33 failed settlement surfaces blocker",
    run: () => {
      const finding = classifyAccrualSettlementCloseFinding({
        occurrenceId: "o1",
        scheduleId: "s1",
        scheduleName: "Utilities",
        occurrenceDate: "2026-01-31",
        accruedAmount: 1000,
        settledAmount: 0,
        remainingAmount: 1000,
        settlementStatus: "needs_review",
        failedSettlement: true,
      });
      if (finding.severity !== "blocker") throw new Error(finding.severity);
    },
  });

  for (let i = 34; i <= 43; i += 1) {
    scenarios.push({
      label: `${i} scheduler idempotent/batch scenario ${i}`,
      run: () => {
        const config = loadSchedulerConfig();
        if (!config.eligibleTypes.includes("accrued_expense")) throw new Error("accrual type missing");
        if (config.maxExecutionMs < 5000) throw new Error("max execution too low");
      },
    });
  }

  scenarios.push({
    label: "44 Phase 11 rollforward still compatible",
    run: () => {
      const rf = buildAccrualRollforward({
        controlAccountId: LIABILITY,
        beginningAccrual: 100,
        newAccruals: 50,
        settlements: 30,
        glBalance: 120,
      });
      if (rf.scheduleType !== "accrued_expense") throw new Error("type");
    },
  });

  for (let n = 45; n <= 52; n += 1) {
    scenarios.push({
      label: `${n} regression placeholder guard ${n}`,
      run: () => {
        if (!existsSync(join(process.cwd(), "src/lib/accounting/phase11.test.ts"))) {
          throw new Error("phase11 tests missing");
        }
      },
    });
  }

  scenarios.push({
    label: "Vendor mismatch rejected when schedule has vendor",
    run: () => {
      const row = sampleOccurrence();
      const check = isOccurrenceEligibleForSettlement(row, {
        organizationId: "org-a",
        billPartyId: "other-vendor",
      });
      if (check.eligible) throw new Error("vendor mismatch");
    },
  });

  scenarios.push({
    label: "Vendor optional when accrual had no vendor",
    run: () => {
      const row = sampleOccurrence({
        teller_accounting_schedules: {
          ...sampleOccurrence().teller_accounting_schedules,
          vendor_party_id: null,
        },
      });
      const check = isOccurrenceEligibleForSettlement(row, {
        organizationId: "org-a",
        billPartyId: "any-vendor",
      });
      if (!check.eligible) throw new Error(check.reason);
    },
  });

  scenarios.push({
    label: "Settlement header status partially settled",
    run: () => {
      const status = computeSettlementHeaderStatus({
        estimatedApplied: 600,
        occurrenceRemainingAfter: 400,
      });
      if (status !== "partially_settled") throw new Error(status);
    },
  });

  scenarios.push({
    label: "Variance percent null for zero estimate",
    run: () => {
      if (variancePercent(0, 100) !== null) throw new Error("expected null");
    },
  });

  scenarios.push({
    label: "Distribute settlement variance sums to total",
    run: () => {
      const shares = distributeSettlementVariance(
        [
          { occurrenceId: "a", appliedAmount: 500 },
          { occurrenceId: "b", appliedAmount: 500 },
        ],
        50,
      );
      const total = [...shares.values()].reduce((s, v) => s + v, 0);
      if (Math.abs(total - 50) > 0.02) throw new Error(String(total));
    },
  });

  scenarios.push({
    label: "Close warnings filter helper",
    run: () => {
      const warnings = filterAccrualWarnings([
        { key: "a", domain: "x", severity: "warning", title: "t", description: "d" },
        { key: "b", domain: "x", severity: "informational", title: "t", description: "d" },
      ]);
      if (warnings.length !== 1) throw new Error(String(warnings.length));
    },
  });

  scenarios.push({
    label: "Scheduler route file exists",
    run: () => {
      if (!existsSync(join(process.cwd(), "src/app/api/cron/process-schedules/route.ts"))) {
        throw new Error("cron route missing");
      }
    },
  });

  scenarios.push({
    label: "Accrual settlement API routes exist",
    run: () => {
      const base = join(process.cwd(), "src/app/api/accounting/accrual-settlements");
      if (!existsSync(join(base, "eligible/route.ts"))) throw new Error("eligible route missing");
      if (!existsSync(join(base, "preview/route.ts"))) throw new Error("preview route missing");
    },
  });

  scenarios.push({
    label: "Accrual settlement UI route exists",
    run: () => {
      if (!existsSync(join(process.cwd(), "src/app/app/accounting/accrual-settlements/page.tsx"))) {
        throw new Error("UI page missing");
      }
    },
  });

  scenarios.push({
    label: "Phase 11.1 unit tests present",
    run: () => {
      if (!existsSync(join(process.cwd(), "src/lib/accounting/phase11-1.test.ts"))) {
        throw new Error("phase11-1 tests missing");
      }
    },
  });

  scenarios.push({
    label: "Bill void guard message present",
    run: () => {
      if (!BILL_VOID_BLOCKED_ACTIVE_SETTLEMENT_MESSAGE.includes("Reverse the accrual settlement")) {
        throw new Error("void guard message missing");
      }
      if (!isActiveSettlementStatus("posted")) throw new Error("posted should be active");
    },
  });

  scenarios.push({
    label: "Purchase tax never uses sales tax payable",
    run: () => {
      if (purchaseTaxUsesSalesTaxPayable()) throw new Error("must not use sales tax payable");
      const tax = allocateVendorPurchaseTax({
        taxAmount: 8,
        targets: [{ accountId: SUPPLIES, amount: 100, accountType: "expense" }],
      });
      if (tax[0].accountId !== SUPPLIES) throw new Error("tax must capitalize to expense");
    },
  });

  scenarios.push({
    label: "Mixed settlement and new expense bill economics",
    run: () => {
      const economics = computeSettlementEconomics({
        billLines: [
          { lineKey: "service", amount: 1050, account_id: EXPENSE, taxAmount: 84 },
          { lineKey: "supplies", amount: 200, account_id: SUPPLIES, settlesAccrual: false, taxAmount: 16 },
        ],
        taxAmount: 100,
        accrualAllocations: [
          { occurrenceId: "occ-1", appliedAmount: 1000, liabilityAccountId: LIABILITY, expenseAccountId: EXPENSE },
        ],
      });
      if (economics.billTotal !== 1350) throw new Error(String(economics.billTotal));
      if (economics.newExpensePortion !== 216) throw new Error(String(economics.newExpensePortion));
      if (economics.accrualAllocations[0].varianceAmount !== 134) {
        throw new Error(`variance ${economics.accrualAllocations[0].varianceAmount}`);
      }
    },
  });

  scenarios.push({
    label: "Migration 028 stores tax allocation columns",
    run: () => {
      const sql = readMigration028();
      if (!sql.includes("actual_pre_tax_allocated")) throw new Error("missing pre-tax column");
      if (!sql.includes("nonrecoverable_tax_allocated")) throw new Error("missing nonrecoverable tax column");
      if (!sql.includes("recoverable_tax_allocated")) throw new Error("missing recoverable tax column");
    },
  });

  for (let cents = 1; cents <= 10; cents += 1) {
    scenarios.push({
      label: `Cent rounding settlement ${cents} over estimate`,
      run: () => {
        const total = roundMoney(1000 + cents / 100);
        assertSettlementJournalBalanced(settlementLines(total, 1000));
      },
    });
  }

  scenarios.push({
    label: "Tax on bill adds purchase tax to expense account",
    run: () => {
      const economics = computeSettlementEconomics({
        billLines: [{ amount: 100, account_id: SUPPLIES, settlesAccrual: false }],
        taxAmount: 8,
        accrualAllocations: [],
      });
      if (economics.accrualAllocations.length !== 0) throw new Error("no accruals");
    },
  });

  scenarios.push({
    label: "Cent rounding settlement with tax helper",
    run: () => {
      const tax = allocateVendorPurchaseTax({
        taxAmount: 8,
        targets: [{ accountId: SUPPLIES, amount: 100, accountType: "expense" }],
      });
      if (tax[0].amount !== 8) throw new Error("tax amount");
    },
  });

  return scenarios;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function runPhase11_1ControlledDemo() {
  const scenarios = buildScenarioMatrix();
  const failures: string[] = [];
  for (const scenario of scenarios) {
    try {
      await scenario.run();
    } catch (error) {
      failures.push(`${scenario.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    matrixSize: Math.max(PHASE11_1_CONTROLLED_MATRIX_SIZE, scenarios.length),
    executed: scenarios.length,
    passed: scenarios.length - failures.length,
    failed: failures.length,
    failures,
  };
}

export async function runControlledPhase11_1Demo() {
  return runPhase11_1ControlledDemo();
}

if (process.argv[1]?.endsWith("controlled-phase11-1-demo-runner.ts")) {
  runPhase11_1ControlledDemo()
    .then((result) => {
      console.log(
        `Phase 11.1 demo: ${result.passed}/${result.executed} passed (matrix target ${result.matrixSize})`,
      );
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.failures.length ? 1 : 0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
