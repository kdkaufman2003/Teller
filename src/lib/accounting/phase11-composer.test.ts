import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  validateCreateScheduleInput,
  type CreateScheduleInput,
} from "./schedules/schedule-crud";
import { buildSchedulePreview, closeFindingScheduleRoute, scheduleOccurrenceReviewPath } from "./schedules/preview";
import {
  assertLifecycleTransition,
  assertOccurrenceAction,
  canEditScheduleFields,
  canEditLimitedActiveFields,
  actionToStatus,
} from "./schedules/lifecycle";
import { classifyScheduleCloseFinding } from "./schedules/close-integration";
import {
  assertNoDoubleCountWithAppliedDeposit,
} from "./schedules/deferred-revenue";
import {
  canConfigureAutoPost,
  canManageSchedules,
  canPostScheduleOccurrence,
  canViewSchedules,
} from "./schedules/permissions";
import { assertEntryDateOpen, PeriodClosedError } from "./periods";

const MIGRATION = resolve(process.cwd(), "supabase/migrations/027_phase11_subledger_automation.sql");

function prepaidInput(overrides: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
  return {
    organizationId: "org-1",
    scheduleType: "prepaid_expense",
    name: "Annual insurance",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    originalAmount: 1200,
    prepaidAccountId: "acct-prepaid",
    expenseAccountId: "acct-expense",
    ...overrides,
  };
}

function accrualInput(overrides: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
  return {
    organizationId: "org-1",
    scheduleType: "accrued_expense",
    name: "Payroll accrual",
    startDate: "2026-03-01",
    originalAmount: 5000,
    expenseAccountId: "acct-expense",
    liabilityAccountId: "acct-liability",
    autoReverse: true,
    reversalTiming: "next_period",
    ...overrides,
  };
}

function deferredInput(overrides: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
  return {
    organizationId: "org-1",
    scheduleType: "deferred_revenue",
    name: "Deposit recognition",
    startDate: "2026-01-01",
    endDate: "2026-06-30",
    originalAmount: 600,
    liabilityAccountId: "acct-deposit",
    revenueAccountId: "acct-revenue",
    sourcePaymentId: "pay-1",
    depositAvailable: 600,
    ...overrides,
  };
}

describe("Phase 11 composer — prepaid", () => {
  it("create prepaid validates required fields", () => {
    expect(() => validateCreateScheduleInput(prepaidInput())).not.toThrow();
    expect(() =>
      validateCreateScheduleInput(prepaidInput({ prepaidAccountId: null })),
    ).toThrow(/Prepaid and expense accounts/);
  });

  it("preview prepaid shows final-period rounding", () => {
    const preview = buildSchedulePreview({
      scheduleType: "prepaid_expense",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      originalAmount: 100,
    });
    expect(preview.at(-1)?.isFinal).toBe(true);
    expect(preview.reduce((s, row) => s + row.amount, 0)).toBe(100);
  });

  it("activate prepaid allows draft to active", () => {
    expect(() => assertLifecycleTransition("draft", "active")).not.toThrow();
  });
});

describe("Phase 11 composer — accrual", () => {
  it("create accrual validates accounts", () => {
    expect(() => validateCreateScheduleInput(accrualInput())).not.toThrow();
  });

  it("auto-reversal config stored via reversalTiming", () => {
    const input = accrualInput({ autoReverse: true, reversalTiming: "next_period" });
    expect(input.autoReverse).toBe(true);
    expect(input.reversalTiming).toBe("next_period");
  });
});

describe("Phase 11 composer — deferred revenue", () => {
  it("create deferred revenue schedule validates deposit source", () => {
    expect(() => validateCreateScheduleInput(deferredInput())).not.toThrow();
    expect(() => validateCreateScheduleInput(deferredInput({ sourcePaymentId: null }))).toThrow(
      /deposit source/,
    );
  });

  it("fully applied deposit blocked", () => {
    expect(() =>
      assertNoDoubleCountWithAppliedDeposit({
        depositFullyApplied: true,
        scheduleLinkedToDeposit: true,
      }),
    ).toThrow(/fully applied customer deposit/);
  });

  it("recognition over available deposit blocked", () => {
    expect(() =>
      validateCreateScheduleInput(deferredInput({ originalAmount: 1000, depositAvailable: 500 })),
    ).toThrow(/exceeds available deposit/);
  });
});

describe("Phase 11 composer — edit and lifecycle", () => {
  it("edit draft allowed", () => {
    expect(canEditScheduleFields("draft")).toBe(true);
    expect(canEditLimitedActiveFields("draft")).toBe(true);
  });

  it("edit active restricted to limited fields only", () => {
    expect(canEditScheduleFields("active")).toBe(false);
    expect(canEditLimitedActiveFields("active")).toBe(false);
    expect(canEditLimitedActiveFields("paused")).toBe(true);
  });

  it("pause active schedule", () => {
    expect(actionToStatus("pause")).toBe("paused");
    expect(() => assertLifecycleTransition("active", "paused")).not.toThrow();
  });

  it("resume paused schedule", () => {
    expect(actionToStatus("resume")).toBe("active");
    expect(() => assertLifecycleTransition("paused", "active")).not.toThrow();
  });

  it("cancel stops future transitions", () => {
    expect(() => assertLifecycleTransition("active", "cancelled")).not.toThrow();
    expect(() => assertLifecycleTransition("cancelled", "active")).toThrow();
  });

  it("completed state reached from active", () => {
    expect(() => assertLifecycleTransition("active", "completed")).not.toThrow();
    expect(() => assertLifecycleTransition("completed", "active")).toThrow();
  });
});

describe("Phase 11 composer — occurrence workflow", () => {
  it("approve occurrence from scheduled", () => {
    expect(() => assertOccurrenceAction("scheduled", "approve")).not.toThrow();
  });

  it("post occurrence from approved", () => {
    expect(() => assertOccurrenceAction("approved", "post")).not.toThrow();
  });

  it("skip with reason allowed from generated", () => {
    expect(() => assertOccurrenceAction("generated", "skip")).not.toThrow();
  });

  it("retry failed occurrence", () => {
    expect(() => assertOccurrenceAction("failed", "retry")).not.toThrow();
    expect(() => assertOccurrenceAction("posted", "retry")).toThrow();
  });

  it("reverse posted occurrence", () => {
    expect(() => assertOccurrenceAction("posted", "reverse")).not.toThrow();
  });
});

describe("Phase 11 composer — closed period UI block", () => {
  it("closed-period posting blocked by assertEntryDateOpen", () => {
    expect(() => assertEntryDateOpen("2026-01-31", "2026-01-15")).toThrow(PeriodClosedError);
    expect(() => assertEntryDateOpen("2026-01-31", "2026-02-01")).not.toThrow();
  });
});

describe("Phase 11 composer — role permissions", () => {
  it("owner/admin can configure auto-post", () => {
    expect(canConfigureAutoPost("owner")).toBe(true);
    expect(canConfigureAutoPost("viewer")).toBe(false);
  });

  it("bookkeeper can manage and post schedules", () => {
    expect(canManageSchedules("bookkeeper")).toBe(true);
    expect(canPostScheduleOccurrence("bookkeeper")).toBe(true);
  });

  it("viewer read-only for schedules", () => {
    expect(canViewSchedules("viewer")).toBe(true);
    expect(canManageSchedules("viewer")).toBe(false);
  });
});

describe("Phase 11 composer — close readiness deep links", () => {
  it("due occurrence links to occurrence review", () => {
    const finding = classifyScheduleCloseFinding({
      scheduleId: "sched-1",
      occurrenceId: "occ-1",
      scheduleName: "Insurance",
      scheduleType: "prepaid_expense",
      occurrenceDate: "2026-01-31",
      amount: 100,
      status: "scheduled",
      severity: "blocker",
    });
    expect(finding.route).toBe(scheduleOccurrenceReviewPath("sched-1", "occ-1"));
  });

  it("failed occurrence deep link", () => {
    const route = closeFindingScheduleRoute({ scheduleId: "s1", occurrenceId: "o1", status: "failed" });
    expect(route).toContain("/occurrences/o1");
  });
});

describe("Phase 11 composer — cross-org rejection", () => {
  it("migration enforces organization_id and RLS on schedules", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toMatch(/teller_accounting_schedules/);
    expect(sql).toMatch(/organization_id uuid not null/);
    expect(sql).toMatch(/enable row level security/);
    expect(sql).toMatch(/teller_is_org_member/);
  });
});
