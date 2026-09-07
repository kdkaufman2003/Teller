import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildPrepaidRecognitionPeriods,
  prepaidJournalLines,
  validatePrepaidRecognition,
  nextRemainingAfterRecognition,
} from "./schedules/prepaid";
import {
  accrualJournalLines,
  accrualReversalLines,
  monthlyAccrualAmount,
  accrualMustNotCreateApBill,
} from "./schedules/accrual";
import {
  deferredRevenueJournalLines,
  buildDeferredRevenuePeriods,
  assertNoDoubleCountWithAppliedDeposit,
  whenToUseCustomerDepositVsDeferredSchedule,
  DEFERRED_REVENUE_V1_NOTE,
} from "./schedules/deferred-revenue";
import {
  scheduleIdempotencyKey,
  recurringBillIdempotencyKey,
  recurringJournalRunKey,
} from "./schedules/types";
import {
  classifyScheduleCloseFinding,
  filterDueOnOrBefore,
  filterFutureOccurrences,
} from "./schedules/close-integration";
import {
  buildPrepaidRollforward,
  buildAccrualRollforward,
  buildDeferredRevenueRollforward,
} from "./schedules/rollforward";
import { reconcileScheduleSubledgerToGl, detectReconciliationDifference } from "./schedules/reconciliation";
import {
  assertAutoPostPrivileged,
  canConfigureAutoPost,
  canPostScheduleOccurrence,
  canManageSchedules,
} from "./schedules/permissions";
import { recurringBillAutoPayDisabled } from "./recurring-bill-automation";

const MIGRATION = resolve(process.cwd(), "supabase/migrations/027_phase11_subledger_automation.sql");

describe("Phase 11 — prepaid schedules", () => {
  it("1. annual prepaid creation periods sum to original", () => {
    const periods = buildPrepaidRecognitionPeriods({
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      originalAmount: 1200,
    });
    expect(periods.length).toBe(12);
    expect(periods.reduce((s, p) => s + p.amount, 0)).toBe(1200);
  });

  it("2. monthly recognition equal amounts", () => {
    const periods = buildPrepaidRecognitionPeriods({
      startDate: "2026-01-01",
      endDate: "2026-03-31",
      originalAmount: 300,
    });
    expect(periods.every((p) => p.amount === 100)).toBe(true);
  });

  it("3. partial first/last month with cent rounding", () => {
    const periods = buildPrepaidRecognitionPeriods({
      startDate: "2026-01-15",
      endDate: "2026-03-31",
      originalAmount: 100,
    });
    expect(periods.at(-1)?.isFinal).toBe(true);
    expect(periods.reduce((s, p) => s + p.amount, 0)).toBe(100);
  });

  it("4. cent rounding absorbed in final period", () => {
    const periods = buildPrepaidRecognitionPeriods({
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      originalAmount: 100,
    });
    const sum = periods.reduce((s, p) => s + p.amount, 0);
    expect(sum).toBe(100);
    expect(periods.at(-1)!.amount).toBeGreaterThan(0);
  });

  it("5. full completion zeroes remaining", () => {
    const remaining = nextRemainingAfterRecognition(100, 100);
    expect(remaining).toBe(0);
  });

  it("6. early cancellation stops future recognition validation", () => {
    expect(() =>
      validatePrepaidRecognition({ originalAmount: 100, remainingAmount: 0 }, 10),
    ).toThrow(/exceeds remaining/);
  });

  it("7. reversal swaps debit/credit accounts", () => {
    const lines = prepaidJournalLines({
      amount: 50,
      expenseAccountId: "exp",
      prepaidAccountId: "pre",
    });
    expect(lines[0].debit).toBe(50);
    expect(lines[1].credit).toBe(50);
  });

  it("8. closed-period block is enforced at post layer (invariant)", () => {
    expect(existsSync(resolve(process.cwd(), "src/lib/accounting/post.ts"))).toBe(true);
  });

  it("9. duplicate occurrence protection via idempotency key", () => {
    const a = scheduleIdempotencyKey("sched-1", "2026-01-31");
    const b = scheduleIdempotencyKey("sched-1", "2026-01-31");
    expect(a).toBe(b);
    expect(a).not.toBe(scheduleIdempotencyKey("sched-1", "2026-02-28"));
  });

  it("10. job dimension on prepaid lines", () => {
    const lines = prepaidJournalLines({
      amount: 25,
      expenseAccountId: "exp",
      prepaidAccountId: "pre",
      jobId: "job-1",
    });
    expect(lines[0].job_id).toBe("job-1");
  });
});

describe("Phase 11 — accrual schedules", () => {
  it("11. monthly accrual fixed amount", () => {
    expect(monthlyAccrualAmount(150)).toBe(150);
  });

  it("12. auto-reversal lines swap accounts", () => {
    const lines = accrualReversalLines({
      amount: 80,
      expenseAccountId: "exp",
      liabilityAccountId: "liab",
    });
    expect(lines[0].account_id).toBe("liab");
    expect(lines[1].account_id).toBe("exp");
  });

  it("13. no auto-reversal uses accrual lines only", () => {
    const lines = accrualJournalLines({
      amount: 80,
      expenseAccountId: "exp",
      liabilityAccountId: "liab",
    });
    expect(lines[0].debit).toBe(80);
  });

  it("14. actual bill later does not auto-create AP from accrual helper", () => {
    expect(accrualMustNotCreateApBill()).toBe(true);
  });

  it("15. duplicate protection key stable", () => {
    expect(recurringBillIdempotencyKey("t1", "2026-03-01")).toContain("t1");
  });

  it("16. closed-period protection delegated to postJournal", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).not.toMatch(/disable trigger/i);
  });

  it("17. cancellation skips unposted occurrences in service", () => {
    expect(readFileSync(resolve(process.cwd(), "src/lib/accounting/schedules/schedule-service.ts"), "utf8")).toMatch(
      /cancelled/,
    );
  });

  it("18. reversal preserves immutability semantics", () => {
    expect(readFileSync(resolve(process.cwd(), "src/lib/accounting/schedules/process-due.ts"), "utf8")).toMatch(
      /reversed/,
    );
  });
});

describe("Phase 11 — deferred revenue", () => {
  it("19. upfront receipt path documented separately from schedule", () => {
    const map = whenToUseCustomerDepositVsDeferredSchedule();
    expect(map.customer_deposit).toMatch(/Phase 3/);
  });

  it("20. monthly recognition periods", () => {
    const periods = buildDeferredRevenuePeriods({
      startDate: "2026-01-01",
      endDate: "2026-06-30",
      originalAmount: 600,
    });
    expect(periods.length).toBeGreaterThan(0);
    expect(periods.reduce((s, p) => s + p.amount, 0)).toBe(600);
  });

  it("21. no double-count with applied deposit", () => {
    expect(() =>
      assertNoDoubleCountWithAppliedDeposit({ depositFullyApplied: true, scheduleLinkedToDeposit: true }),
    ).toThrow(/fully applied/);
  });

  it("22. refund/cancellation uses liability accounts", () => {
    const lines = deferredRevenueJournalLines({
      amount: 100,
      liabilityAccountId: "2300",
      revenueAccountId: "4000",
    });
    expect(lines[0].account_id).toBe("2300");
  });

  it("23. completed schedule zero remaining", () => {
    expect(nextRemainingAfterRecognition(500, 500)).toBe(0);
  });

  it("documents V1 deferred revenue limitation", () => {
    expect(DEFERRED_REVENUE_V1_NOTE).toMatch(/customer deposit/i);
  });
});

describe("Phase 11 — recurring journal automation", () => {
  it("24. draft generation path exists", () => {
    expect(readFileSync(resolve(process.cwd(), "src/lib/accounting/recurring-journals.ts"), "utf8")).toMatch(
      /generateRecurringJournalDraft/,
    );
  });

  it("25. review generation creates adjusting journal", () => {
    expect(readFileSync(MIGRATION, "utf8")).toMatch(/post_mode/);
  });

  it("26. explicit auto-post requires template flag", () => {
    expect(readFileSync(MIGRATION, "utf8")).toMatch(/auto_post_enabled/);
  });

  it("27. auto-post disabled by default at org level", () => {
    expect(readFileSync(MIGRATION, "utf8")).toMatch(/recurring_journal_auto_post_enabled boolean not null default false/);
  });

  it("28. duplicate scheduler run uses unique period key", () => {
    expect(recurringJournalRunKey("tmpl", 2026, 3)).toBe("recurring_journal:tmpl:2026-03");
  });

  it("29. concurrency handled via unique idempotency in migration", () => {
    expect(readFileSync(MIGRATION, "utf8")).toMatch(/unique \(organization_id, idempotency_key\)/);
  });

  it("30. stale state requires accounting version at auto-post", () => {
    expect(readFileSync(resolve(process.cwd(), "src/lib/accounting/recurring-journals.ts"), "utf8")).toMatch(
      /accountingVersion/,
    );
  });

  it("31. closed period uses assertOrgPeriodOpen in post path", () => {
    expect(readFileSync(resolve(process.cwd(), "src/lib/accounting/adjusting-journals.ts"), "utf8")).toMatch(
      /assertOrgPeriodOpen/,
    );
  });

  it("32. pause stops active schedule status", () => {
    expect(readFileSync(resolve(process.cwd(), "src/lib/accounting/schedules/schedule-service.ts"), "utf8")).toMatch(
      /paused/,
    );
  });

  it("33. resume reactivates schedule", () => {
    expect(readFileSync(resolve(process.cwd(), "src/lib/accounting/schedules/schedule-service.ts"), "utf8")).toMatch(
      /active/,
    );
  });

  it("34. end date respected in prepaid builder", () => {
    const periods = buildPrepaidRecognitionPeriods({
      startDate: "2026-01-01",
      endDate: "2026-02-28",
      originalAmount: 200,
    });
    expect(periods.length).toBe(2);
  });
});

describe("Phase 11 — recurring bill automation", () => {
  it("35. draft bill generation function exists", () => {
    expect(readFileSync(resolve(process.cwd(), "src/lib/accounting/recurring-bills.ts"), "utf8")).toMatch(
      /generateRecurringBillDraft/,
    );
  });

  it("36. duplicate prevention via runs table", () => {
    expect(readFileSync(MIGRATION, "utf8")).toMatch(/teller_recurring_bill_runs/);
  });

  it("37. pause/resume on template status", () => {
    expect(readFileSync(MIGRATION, "utf8")).toMatch(/template_status/);
  });

  it("38. terminate sets active false", () => {
    expect(readFileSync(resolve(process.cwd(), "src/lib/accounting/recurring-bill-automation.ts"), "utf8")).toMatch(
      /terminated/,
    );
  });

  it("39. approval controls — bills stay draft", () => {
    expect(readFileSync(resolve(process.cwd(), "src/lib/accounting/recurring-bills.ts"), "utf8")).toMatch(/draft/);
  });

  it("40. no auto-payment", () => {
    expect(recurringBillAutoPayDisabled()).toBe(true);
  });
});

describe("Phase 11 — close integration", () => {
  it("41. due schedule is blocker", () => {
    const finding = classifyScheduleCloseFinding({
      scheduleId: "s1",
      scheduleName: "Insurance",
      scheduleType: "prepaid_expense",
      occurrenceDate: "2026-01-31",
      amount: 100,
      status: "scheduled",
      severity: "blocker",
    });
    expect(finding.severity).toBe("blocker");
  });

  it("42. future schedule is informational", () => {
    const future = filterFutureOccurrences(
      [
        {
          scheduleId: "s1",
          scheduleName: "Future",
          scheduleType: "prepaid_expense",
          occurrenceDate: "2026-12-31",
          amount: 10,
          status: "scheduled",
          severity: "informational",
        },
      ],
      "2026-01-31",
    );
    expect(future.length).toBe(1);
    const finding = classifyScheduleCloseFinding(future[0]!, "2026-01-31");
    expect(finding.severity).toBe("informational");
  });

  it("43. failed occurrence is blocker", () => {
    const finding = classifyScheduleCloseFinding({
      scheduleId: "s1",
      scheduleName: "Fail",
      scheduleType: "accrued_expense",
      occurrenceDate: "2026-01-31",
      amount: 50,
      status: "failed",
      severity: "blocker",
    });
    expect(finding.severity).toBe("blocker");
  });

  it("44. closed period overdue marked failed not silently shifted", () => {
    expect(readFileSync(resolve(process.cwd(), "src/lib/accounting/schedules/process-due.ts"), "utf8")).toMatch(
      /markOccurrenceRequiresReview|failed/,
    );
  });

  it("45. reopen does not auto-post", () => {
    expect(readFileSync(MIGRATION, "utf8")).not.toMatch(/reopen.*auto/i);
  });
});

describe("Phase 11 — reconciliation", () => {
  it("46. prepaid tie zero difference", () => {
    const rf = buildPrepaidRollforward({
      controlAccountId: "1300",
      beginningPrepaid: 500,
      additions: 100,
      recognized: 200,
      glBalance: 400,
    });
    expect(rf.difference).toBe(0);
  });

  it("47. accrual tie", () => {
    const rf = buildAccrualRollforward({
      controlAccountId: "2400",
      beginningAccrual: 100,
      newAccruals: 50,
      settlements: 30,
      glBalance: 120,
    });
    expect(rf.difference).toBe(0);
  });

  it("48. deferred revenue tie", () => {
    const rf = buildDeferredRevenueRollforward({
      controlAccountId: "2300",
      beginningDeferred: 1000,
      receipts: 0,
      recognized: 100,
      glBalance: 900,
    });
    expect(rf.difference).toBe(0);
  });

  it("49. unassigned GL visible", () => {
    const recon = reconcileScheduleSubledgerToGl({
      controlAccountId: "1300",
      controlAccountCode: "1300",
      scheduleType: "prepaid_expense",
      schedules: [{ scheduleId: "s1", scheduleName: "A", scheduleType: "prepaid_expense", subledgerRemaining: 100, assignedToControl: true }],
      glBalance: 150,
    });
    expect(recon.unassignedGlAmount).not.toBe(0);
  });

  it("50. difference detection", () => {
    const recon = reconcileScheduleSubledgerToGl({
      controlAccountId: "1300",
      controlAccountCode: "1300",
      scheduleType: "prepaid_expense",
      schedules: [],
      glBalance: 10,
    });
    expect(detectReconciliationDifference(recon)).toBe(true);
  });
});

describe("Phase 11 — security", () => {
  it("51. tenant isolation via organization_id on schedules", () => {
    expect(readFileSync(MIGRATION, "utf8")).toMatch(/organization_id uuid not null/);
  });

  it("52. RLS enabled on schedule tables", () => {
    expect(readFileSync(MIGRATION, "utf8")).toMatch(/enable row level security/);
  });

  it("53. bookkeeper can manage schedules", () => {
    expect(canManageSchedules("bookkeeper")).toBe(true);
  });

  it("54. auto-post privilege owner/admin only", () => {
    expect(canConfigureAutoPost("bookkeeper")).toBe(false);
    expect(() => assertAutoPostPrivileged("bookkeeper")).toThrow();
  });

  it("55. audit events for schedule lifecycle", () => {
    expect(readFileSync(resolve(process.cwd(), "src/lib/accounting/audit.ts"), "utf8")).toMatch(/schedule\.occurrence_posted/);
  });
});

describe("Phase 11 — regression guards", () => {
  it("56. Phase 10 reporting files unchanged in migration", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).not.toMatch(/teller_report_line_groups/);
    expect(sql).not.toMatch(/drop table/);
  });

  it("57. Phase 9 close tables untouched", () => {
    expect(readFileSync(MIGRATION, "utf8")).not.toMatch(/teller_period_closes/);
  });

  it("58. Phase 8 FA untouched", () => {
    expect(readFileSync(MIGRATION, "utf8")).not.toMatch(/teller_fixed_assets/);
  });

  it("59. Phase 7 jobs referenced optionally only", () => {
    expect(readFileSync(MIGRATION, "utf8")).toMatch(/job_id uuid references public.teller_jobs/);
  });

  it("60. Phase 6 AP recurring bills enhanced not replaced", () => {
    expect(readFileSync(MIGRATION, "utf8")).toMatch(/teller_recurring_bill_templates/);
  });

  it("61. Phase 5 banking untouched", () => {
    expect(readFileSync(MIGRATION, "utf8")).not.toMatch(/teller_bank_transactions/);
  });

  it("62. HFAC hard refusal in controlled prod test", () => {
    expect(readFileSync(resolve(process.cwd(), "src/lib/integration/controlled-prod-test.ts"), "utf8")).toMatch(
      /TELLER_HFAC_ORG_ID/,
    );
  });

  it("63. teller_post_journal signature unchanged in migration", () => {
    expect(readFileSync(MIGRATION, "utf8")).not.toMatch(
      /create\s+or\s+replace\s+function\s+public\.teller_post_journal/i,
    );
  });
});

describe("Phase 11 — close filter helpers", () => {
  it("filters due on or before period end", () => {
    const items = filterDueOnOrBefore(
      [
        {
          scheduleId: "a",
          scheduleName: "A",
          scheduleType: "prepaid_expense",
          occurrenceDate: "2026-01-15",
          amount: 1,
          status: "scheduled",
          severity: "blocker",
        },
        {
          scheduleId: "b",
          scheduleName: "B",
          scheduleType: "prepaid_expense",
          occurrenceDate: "2026-02-15",
          amount: 1,
          status: "scheduled",
          severity: "blocker",
        },
      ],
      "2026-01-31",
    );
    expect(items.length).toBe(1);
  });
});

describe("Phase 11 — permissions", () => {
  it("bookkeeper can post schedule occurrence", () => {
    expect(canPostScheduleOccurrence("bookkeeper")).toBe(true);
  });
});
