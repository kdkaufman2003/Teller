/**
 * Central tiered test configuration.
 * TELLER_TEST_PHASE selects the active phase (default 13).
 */

export const CURRENT_PHASE = Number(process.env.TELLER_TEST_PHASE ?? "13");

/** Controlled demo scripts — each uses a dedicated demo org (safe to parallelize across phases). */
export const PHASE_DEMOS = {
  5: { script: "demo:phase5:controlled", total: 18, orgEnv: "TELLER_PHASE5_DEMO_ORG_ID" },
  6: { script: "demo:phase6:controlled", total: 32, orgEnv: "TELLER_PHASE6_DEMO_ORG_ID" },
  7: { script: "demo:phase7:controlled", total: 45, orgEnv: "TELLER_PHASE7_DEMO_ORG_ID" },
  8: { script: "demo:phase8:controlled", total: 67, orgEnv: "TELLER_PHASE8_DEMO_ORG_ID" },
  9: { script: "demo:phase9:controlled", total: 102, orgEnv: "TELLER_PHASE9_DEMO_ORG_ID" },
  10: { script: "demo:phase10:controlled", total: 110, orgEnv: "TELLER_PHASE10_DEMO_ORG_ID" },
  11: { script: "demo:phase11:controlled", total: 105, orgEnv: "TELLER_PHASE11_DEMO_ORG_ID" },
  "11.1": { script: "demo:phase11-1:controlled", total: 88, orgEnv: "TELLER_PHASE11_1_DEMO_ORG_ID" },
  12: { script: "demo:phase12:controlled", total: 110, orgEnv: "TELLER_PHASE12_DEMO_ORG_ID" },
  13: { script: "demo:phase13:controlled", total: 178, orgEnv: "TELLER_PHASE13_DEMO_ORG_ID" },
};

export const PHASE_VERIFY = {
  16: "verify:phase16j:production",
  15: "verify:migration:035:controlled",
  14: "verify:migration:032:controlled",
  13: "verify:phase13:controlled",
  12: "verify:phase12:controlled",
  11: "verify:phase11:controlled",
  "11.1": "verify:phase11-1:controlled",
};

export const PHASE_DEPLOY_AUDIT = {
  13: "audit:phase13:deployment-compat",
  12: "audit:phase12:deployment-compat",
  11: "audit:phase11:deployment-compat",
  "11.1": "audit:phase11-1:deployment-compat",
  10: "audit:phase10:deployment-compat",
  9: "audit:phase9:deployment-compat",
  8: "audit:phase8:deployment-compat",
  7: "audit:phase7:deployment-compat",
};

/** Vitest files for fast loop — no production DB. */
export const FAST_UNIT_PATTERNS = [
  "src/lib/accounting/phase13.test.ts",
  "src/lib/accounting/post.test.ts",
  "src/lib/accounting/job-profitability.test.ts",
  "src/lib/accounting/phase6-ap.test.ts",
  "src/lib/accounting/subledger-reconciliation.test.ts",
  "src/lib/accounting/integrity.test.ts",
  "src/lib/integration/safety.test.ts",
  "src/lib/integration/controlled-prod-test.test.ts",
  "src/lib/integration/controlled-phase-isolation.test.ts",
  "src/lib/planning/budgets/phase14.test.ts",
  "src/lib/planning/budgets/phase14b.test.ts",
  "src/lib/planning/reports/phase14c.test.ts",
  "src/lib/planning/reports/phase14d.test.ts",
  "src/lib/planning/reports/phase14e.test.ts",
  "src/lib/planning/reports/phase14f.test.ts",
  "src/lib/planning/reports/phase14g.test.ts",
  "src/lib/planning/reports/phase14h.test.ts",
  "src/lib/planning/reports/phase14i.test.ts",
  "src/lib/planning/reports/phase14j.test.ts",
  "src/lib/accounting/tax/phase15a.test.ts",
  "src/lib/accounting/tax/phase15b.test.ts",
  "src/lib/accounting/tax/phase15c.test.ts",
  "src/lib/accounting/tax/phase15d.test.ts",
  "src/lib/accounting/tax/phase15e.test.ts",
  "src/lib/accounting/tax/phase15f.test.ts",
  "src/lib/accounting/tax/phase15g.test.ts",
  "src/lib/accounting/tax/phase15h.test.ts",
  "src/lib/accounting/tax/phase15i.test.ts",
  "src/lib/accounting/tax/phase15j.test.ts",
  "src/lib/accounting/phase16a.test.ts",
  "src/lib/accounting/phase16b.test.ts",
];

/** Per-phase unit test files (local vitest only). */
export const PHASE_UNIT_TESTS = {
  5: ["src/lib/banking/**/*.test.ts"],
  6: ["src/lib/accounting/phase6-ap.test.ts", "src/lib/accounting/phase4.test.ts"],
  7: ["src/lib/accounting/job-profitability.test.ts", "src/lib/accounting/job-reports.test.ts"],
  8: ["src/lib/accounting/fixed-asset-*.test.ts"],
  9: ["src/lib/accounting/periods.test.ts", "src/lib/accounting/phase1.test.ts"],
  10: ["src/lib/accounting/phase10.test.ts", "src/lib/accounting/financial-reports.test.ts"],
  11: ["src/lib/accounting/phase11.test.ts", "src/lib/accounting/phase11-composer.test.ts"],
  "11.1": ["src/lib/accounting/phase11-1.test.ts"],
  12: ["src/lib/accounting/phase12.test.ts"],
  13: ["src/lib/accounting/phase13.test.ts"],
  14: ["src/lib/planning/budgets/phase14.test.ts", "src/lib/planning/budgets/phase14b.test.ts", "src/lib/planning/reports/phase14c.test.ts", "src/lib/planning/reports/phase14d.test.ts", "src/lib/planning/reports/phase14e.test.ts", "src/lib/planning/reports/phase14f.test.ts", "src/lib/planning/reports/phase14g.test.ts", "src/lib/planning/reports/phase14h.test.ts", "src/lib/planning/reports/phase14i.test.ts", "src/lib/planning/reports/phase14j.test.ts"],
  16: [
    "src/lib/accounting/phase16a.test.ts",
    "src/lib/accounting/phase16b.test.ts",
    "src/lib/accounting/phase16c.test.ts",
    "src/lib/accounting/phase16d.test.ts",
    "src/lib/accounting/phase16e.test.ts",
    "src/lib/accounting/phase16f.test.ts",
    "src/lib/accounting/phase16g.test.ts",
    "src/lib/accounting/phase16h.test.ts",
    "src/lib/accounting/phase16i.test.ts",
    "src/lib/accounting/phase16j.test.ts",
  ],
  15: [
    "src/lib/accounting/tax/phase15a.test.ts",
    "src/lib/accounting/tax/phase15b.test.ts",
  "src/lib/accounting/tax/phase15c.test.ts",
    "src/lib/accounting/tax/phase15d.test.ts",
    "src/lib/accounting/tax/phase15e.test.ts",
    "src/lib/accounting/tax/phase15f.test.ts",
    "src/lib/accounting/tax/phase15g.test.ts",
  "src/lib/accounting/tax/phase15h.test.ts",
  "src/lib/accounting/tax/phase15i.test.ts",
  "src/lib/accounting/tax/phase15j.test.ts",
  ],
};

/**
 * Dependency-aware regression map (controlled demo phases to rerun).
 * Based on shared modules: post.ts, periods/close, AP, job costing, reporting, GRNI settlement.
 */
export const MODULE_DEPENDENCIES = {
  shared_journal_engine: {
    description: "teller_post_journal callers, post.ts, atomic RPC wrappers",
    demoPhases: [5, 6, 7, 8, 9, 10, 11, "11.1", 12, 13],
    unitPatterns: ["src/lib/accounting/post.test.ts", "src/lib/accounting/integrity.test.ts"],
  },
  period_lock_close: {
    description: "periods.ts, close readiness, month-end",
    demoPhases: [9, 13],
    unitPatterns: ["src/lib/accounting/periods.test.ts"],
  },
  ap_purchasing: {
    description: "bills, POs, vendor credits, GRNI settlement",
    demoPhases: [6, "11.1", 13],
    unitPatterns: ["src/lib/accounting/phase6-ap.test.ts", "src/lib/accounting/phase4.test.ts"],
  },
  job_costing: {
    description: "job-profitability, material/labor attribution",
    demoPhases: [7, 13],
    unitPatterns: ["src/lib/accounting/job-profitability.test.ts"],
  },
  banking: {
    description: "bank match, transfers — no inventory economics",
    demoPhases: [5, 6],
    unitPatterns: ["src/lib/banking/**/*.test.ts"],
  },
  fixed_assets: {
    description: "depreciation, disposal — independent of inventory",
    demoPhases: [8],
    unitPatterns: ["src/lib/accounting/fixed-asset-*.test.ts"],
  },
  payroll: {
    description: "payroll runs, labor entries",
    demoPhases: [12, 7],
    unitPatterns: ["src/lib/accounting/phase12.test.ts"],
  },
  subledger_automation: {
    description: "prepaid, accrual, deferred revenue schedules",
    demoPhases: [11, "11.1", 9],
    unitPatterns: ["src/lib/accounting/phase11.test.ts", "src/lib/accounting/phase11-1.test.ts"],
  },
  financial_reporting: {
    description: "P&L, balance sheet, accountant package",
    demoPhases: [10, 9, 13],
    unitPatterns: ["src/lib/accounting/phase10.test.ts", "src/lib/accounting/financial-reports.test.ts"],
  },
  inventory_grni: {
    description: "inventory module, GRNI, WAC, receipt/bill allocation",
    demoPhases: [13, 6, 7, 9, 10, "11.1"],
    unitPatterns: ["src/lib/accounting/phase13.test.ts"],
  },
  planning: {
    description: "budgets, planning settings, forecast foundations — no GL mutation",
    demoPhases: [9, 10],
    unitPatterns: ["src/lib/planning/budgets/phase14.test.ts", "src/lib/planning/budgets/phase14b.test.ts", "src/lib/planning/reports/phase14c.test.ts"],
  },
  sales_tax: {
    description: "Phase 15 tax domain — no journal posting in 15A",
    demoPhases: [10, 9],
    unitPatterns: [
      "src/lib/accounting/tax/phase15a.test.ts",
      "src/lib/accounting/tax/phase15b.test.ts",
  "src/lib/accounting/tax/phase15c.test.ts",
      "src/lib/accounting/tax/phase15d.test.ts",
      "src/lib/accounting/tax/phase15i.test.ts",
      "src/lib/tax/engine.test.ts",
      "src/lib/tax/determine.test.ts",
    ],
  },
};

/** Primary modules touched per phase — drives test:affected. */
export const PHASE_PRIMARY_MODULES = {
  5: ["banking"],
  6: ["ap_purchasing", "banking"],
  7: ["job_costing"],
  8: ["fixed_assets"],
  9: ["period_lock_close", "financial_reporting"],
  10: ["financial_reporting"],
  11: ["subledger_automation", "period_lock_close"],
  "11.1": ["subledger_automation", "ap_purchasing"],
  12: ["payroll", "job_costing"],
  13: ["inventory_grni", "ap_purchasing", "job_costing", "period_lock_close", "financial_reporting"],
  14: ["planning", "period_lock_close", "financial_reporting"],
  15: ["sales_tax", "shared_journal_engine", "financial_reporting"],
  16: ["shared_journal_engine"],
};

export function demoPhaseKey(phase) {
  return String(phase);
}

export function resolveAffectedDemoPhases(phase = CURRENT_PHASE) {
  const modules = PHASE_PRIMARY_MODULES[demoPhaseKey(phase)] ?? PHASE_PRIMARY_MODULES[13];
  const phaseSet = new Set([phase]);
  for (const mod of modules) {
    const entry = MODULE_DEPENDENCIES[mod];
    if (entry) for (const p of entry.demoPhases) phaseSet.add(p);
  }
  const order = [5, 6, 7, 8, 9, 10, 11, "11.1", 12, 13];
  return order.filter((p) => phaseSet.has(p));
}

export function resolveAffectedUnitPatterns(phase = CURRENT_PHASE) {
  const modules = PHASE_PRIMARY_MODULES[demoPhaseKey(phase)] ?? PHASE_PRIMARY_MODULES[13];
  const patterns = new Set(FAST_UNIT_PATTERNS);
  for (const mod of modules) {
    const entry = MODULE_DEPENDENCIES[mod];
    if (entry) for (const p of entry.unitPatterns) patterns.add(p);
  }
  const phaseTests = PHASE_UNIT_TESTS[demoPhaseKey(phase)] ?? [];
  for (const p of phaseTests) patterns.add(p);
  return [...patterns];
}

export const ALL_DEMO_PHASES = [5, 6, 7, 8, 9, 10, 11, "11.1", 12, 13];

export const DB_ACCEPTANCE_SCRIPTS = {
  16: "accept:phase16:controlled",
  15: "accept:phase15:controlled",
  11: "accept:phase11:controlled",
  "11.1": "accept:phase11-1:controlled",
  12: "accept:phase12:controlled",
  13: "accept:phase13:controlled",
};
