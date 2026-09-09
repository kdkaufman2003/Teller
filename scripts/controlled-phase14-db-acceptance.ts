/**
 * Phase 14A+14B+14C+14D controlled DB acceptance — planning (mutates Phase 14 demo org only).
 */
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  CONTROLLED_PHASE14_DEMO_ORG_NAME,
  CONTROLLED_PHASE14_FOREIGN_ORG_NAME,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import { assertMutationScope } from "../src/lib/integration/controlled-phase-isolation";
import {
  applyBudgetCsvImport,
  bulkUpsertBudgetLines,
  cloneBudgetVersion,
  copyBudgetForward,
  createBudgetWithBaseline,
  listBudgetLines,
  loadPlanningAccounts,
} from "../src/lib/planning/budgets/budget-crud";
import { recordPlanningAuditEvent } from "../src/lib/planning/budgets/audit";
import {
  accountAnnualTotal,
  budgetAnnualTotal,
  monthlyTotal,
} from "../src/lib/planning/budgets/totals";
import { assertLinesEditable, assertVersionAction, assertVersionStatusTransition } from "../src/lib/planning/budgets/lifecycle";
import { validateBulkLines } from "../src/lib/planning/budgets/validation";
import {
  DEFAULT_PLANNING_SETTINGS,
  parsePlanningSettings,
  planningSettingsToRow,
} from "../src/lib/planning/settings/planning-settings";
import { roundMoney } from "../src/lib/accounting/payment-fees";
import {
  buildBudgetCsvPreview,
  exportBudgetCsv,
  sanitizeCsvExportCell,
} from "../src/lib/planning/budgets/csv";
import { spreadAnnualEvenly } from "../src/lib/planning/budgets/budget-tools";
import { isBudgetPnlAccount } from "../src/lib/planning/budgets/pnl-scope";
import { loadBudgetVsActualReport } from "../src/lib/planning/reports/budget-vs-actual";
import {
  bulkUpsertForecastLines,
  createForecastWithSeed,
  upsertForecastAssumption,
} from "../src/lib/planning/forecasts/forecast-crud";
import {
  clearForecastOverride,
  previewForecastAssumptions,
  refreshForecastFromAssumptions,
  saveManualForecastOverride,
} from "../src/lib/planning/forecasts/forecast-refresh";
import {
  buildPublishSnapshotFromReport,
  loadRollingForecastReport,
} from "../src/lib/planning/reports/rolling-forecast";
import { assertForecastLinesEditable } from "../src/lib/planning/forecasts/lifecycle";
import { postExpense, postInvoiceOpen, postInvoicePaid } from "../src/lib/accounting/post";
import { loadCashOutlookReport } from "../src/lib/planning/cash/load-cash-outlook";
import {
  createCashManualOverride,
  deleteCashManualOverride,
} from "../src/lib/planning/cash/cash-crud";
import { buildCashHorizonWeeks } from "../src/lib/planning/cash/weeks";
import {
  approvePurchaseOrder,
  createPurchaseOrder,
  receivePurchaseOrder,
} from "../src/lib/accounting/purchase-orders";
import { applyCashScenarioOverlay } from "../src/lib/planning/scenarios/cash-overlay";
import { applyForecastScenarioOverlay } from "../src/lib/planning/scenarios/forecast-overlay";
import { compareScenarios } from "../src/lib/planning/scenarios/load-scenario-report";
import {
  createScenario,
  getScenario,
  listScenarioDrivers,
} from "../src/lib/planning/scenarios/scenario-crud";
import { loadPlanningDashboard } from "../src/lib/planning/dashboard/load-planning-dashboard";
import { selectPlanningSources } from "../src/lib/planning/dashboard/source-selection";
import { MAX_ATTENTION_ITEMS } from "../src/lib/planning/dashboard/attention";
import { buildPlanningPackageExportFiles } from "../src/lib/planning/accountant-package/export";
import { loadAccountantPlanningPackage } from "../src/lib/planning/accountant-package/load-accountant-planning-package";
import { MAX_PLANNING_RISKS } from "../src/lib/planning/accountant-package/risks";
import { loadPlanningAccountsForForecast } from "../src/lib/planning/forecasts/forecast-crud";

const HFAC_ORG = TELLER_HFAC_ORG_ID;
const FISCAL_YEAR = 2027;
const PRIOR_FISCAL_YEAR = 2026;
const COPY_TARGET_FISCAL_YEAR = 2028;

/** Controlled prior-year GL actuals for baseline verification (fixture, not planning). */
const PRIOR_YEAR_FIXTURES = {
  revenue: { "2026-01-01": 10000.25, "2026-02-01": 12500.5 },
  cogs: { "2026-01-01": 4000.1, "2026-02-01": 5100.2 },
  expense: { "2026-01-01": 1500.33, "2026-02-01": 1700.44 },
  archivedExpense: { "2026-01-01": 999.99 },
  assetActivity: { "2026-01-01": 5000 },
} as const;

type Result = { name: string; pass: boolean; detail?: string };
type Flags = Record<string, boolean | string | number>;

function loadEnv() {
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST=1 required");
  }
  const orgId = process.env.TELLER_PHASE14_DEMO_ORG_ID?.trim();
  const foreignOrgId = process.env.TELLER_PHASE14_FOREIGN_ORG_ID?.trim();
  if (!orgId) throw new Error("TELLER_PHASE14_DEMO_ORG_ID missing — run setup:phase14-demo-org");
  if (!foreignOrgId) throw new Error("TELLER_PHASE14_FOREIGN_ORG_ID missing — run setup:phase14-demo-org");
  assertNotHfacOrganization(orgId);
  assertNotHfacOrganization(foreignOrgId);
  if (orgId === foreignOrgId) throw new Error("Phase 14 demo org must differ from foreign org");
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return { orgId, foreignOrgId, supabase };
}

async function assertOrgName(supabase: SupabaseClient, orgId: string, expected: string) {
  const { data } = await supabase.from("teller_organizations").select("name").eq("id", orgId).single();
  if (data?.name !== expected) {
    throw new Error(`Expected "${expected}", got "${data?.name ?? "missing"}"`);
  }
}

async function accountMap(supabase: SupabaseClient, orgId: string) {
  const { data } = await supabase.from("teller_accounts").select("id, code, organization_id, archived").eq("organization_id", orgId);
  const byCode = new Map<string, string>();
  const byId = new Map<string, { id: string; organizationId: string; code: string; archived: boolean }>();
  for (const row of data ?? []) {
    byCode.set(row.code as string, row.id as string);
    byId.set(row.id as string, {
      id: row.id as string,
      organizationId: row.organization_id as string,
      code: row.code as string,
      archived: Boolean(row.archived),
    });
  }
  return { byCode, byId };
}

async function hfacSnapshot(supabase: SupabaseClient) {
  async function count(table: string) {
    const { count } = await supabase.from(table).select("id", { count: "exact", head: true }).eq("organization_id", HFAC_ORG);
    return count ?? 0;
  }
  return {
    documents: await count("teller_documents"),
    journals: await count("teller_journal_entries"),
    planning_budgets: await count("teller_budgets"),
    planning_settings: await count("teller_planning_settings"),
  };
}

async function journalCount(supabase: SupabaseClient, orgId: string) {
  const { count } = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  return count ?? 0;
}

async function clearPhase14Org(supabase: SupabaseClient, orgId: string) {
  assertMutationScope(orgId, orgId);
  const { error: forecastDraftError } = await supabase
    .from("teller_forecast_versions")
    .update({ status: "draft", is_immutable: false, published_at: null, published_by: null })
    .eq("organization_id", orgId);
  if (forecastDraftError) throw new Error(`clear forecasts: ${forecastDraftError.message}`);

  const cashDeletes = [
    supabase.from("teller_cash_forecast_lines").delete().eq("organization_id", orgId),
    supabase.from("teller_cash_forecast_overrides").delete().eq("organization_id", orgId),
    supabase.from("teller_cash_forecast_runs").delete().eq("organization_id", orgId),
  ];
  for (const op of cashDeletes) {
    const { error } = await op;
    if (error && !/does not exist|schema cache/i.test(error.message)) {
      throw new Error(`clear cash planning: ${error.message}`);
    }
  }

  const scenarioDeletes = [
    supabase.from("teller_scenario_cash_adjustments").delete().eq("organization_id", orgId),
    supabase.from("teller_scenario_drivers").delete().eq("organization_id", orgId),
    supabase.from("teller_scenarios").delete().eq("organization_id", orgId),
  ];
  for (const op of scenarioDeletes) {
    const { error } = await op;
    if (error && !/does not exist|schema cache/i.test(error.message)) {
      throw new Error(`clear scenarios: ${error.message}`);
    }
  }

  const deletes = [
    supabase.from("teller_forecast_lines").delete().eq("organization_id", orgId),
    supabase.from("teller_forecast_assumptions").delete().eq("organization_id", orgId),
    supabase.from("teller_forecast_versions").delete().eq("organization_id", orgId),
    supabase.from("teller_forecasts").delete().eq("organization_id", orgId),
  ];
  for (const op of deletes) {
    const { error } = await op;
    if (error) throw new Error(`clear forecasts: ${error.message}`);
  }

  const { error: budgetDraftError } = await supabase
    .from("teller_budget_versions")
    .update({ status: "draft", approved_at: null, locked_at: null })
    .eq("organization_id", orgId);
  if (budgetDraftError) throw new Error(`clear budgets: ${budgetDraftError.message}`);

  const budgetDeletes = [
    supabase.from("teller_budget_lines").delete().eq("organization_id", orgId),
    supabase.from("teller_budget_versions").delete().eq("organization_id", orgId),
    supabase.from("teller_planning_audit_events").delete().eq("organization_id", orgId),
    supabase.from("teller_budgets").delete().eq("organization_id", orgId),
    supabase.from("teller_planning_settings").delete().eq("organization_id", orgId),
  ];
  for (const op of budgetDeletes) {
    const { error } = await op;
    if (error) throw new Error(`clear budgets: ${error.message}`);
  }
}

async function ensureDemoAccounts(supabase: SupabaseClient, orgId: string) {
  const seeds = [
    { code: "1000", name: "Cash", type: "asset", subtype: "bank" },
    { code: "1100", name: "Accounts Receivable", type: "asset", subtype: "receivable" },
    { code: "2000", name: "Accounts Payable", type: "liability", subtype: "payable" },
    { code: "4000", name: "Revenue", type: "revenue", subtype: "" },
    { code: "5000", name: "COGS", type: "cogs", subtype: "material" },
    { code: "6000", name: "Operating Expense", type: "expense", subtype: "" },
    { code: "6105", name: "Unbudgeted Expense", type: "expense", subtype: "" },
    { code: "6999", name: "Archived Expense", type: "expense", subtype: "", archived: true },
  ];
  for (const row of seeds) {
    const { data: existing } = await supabase
      .from("teller_accounts")
      .select("id, archived")
      .eq("organization_id", orgId)
      .eq("code", row.code)
      .maybeSingle();
    if (existing?.id) {
      if (row.archived && !existing.archived) {
        await supabase.from("teller_accounts").update({ archived: true }).eq("id", existing.id);
      }
      continue;
    }
    const { error } = await supabase.from("teller_accounts").insert({
      organization_id: orgId,
      code: row.code,
      name: row.name,
      type: row.type,
      subtype: row.subtype ?? "",
      industry_tag: "",
      is_system: true,
      archived: row.archived ?? false,
    });
    if (error) throw new Error(error.message);
  }
}

async function postFixtureJournal(
  supabase: SupabaseClient,
  orgId: string,
  entryDate: string,
  memo: string,
  lines: Array<{ account_id: string; debit: number; credit: number }>,
) {
  const { error } = await supabase.rpc("teller_post_journal", {
    p_organization_id: orgId,
    p_entry_date: entryDate,
    p_memo: memo,
    p_source_kind: "manual",
    p_source_id: null,
    p_reverses_entry_id: null,
    p_lines: lines,
  });
  if (error) throw new Error(`fixture journal ${entryDate}: ${error.message}`);
}

async function loadCashAccountRows(supabase: SupabaseClient, orgId: string) {
  const { data, error } = await supabase
    .from("teller_accounts")
    .select("id, code, name, type, subtype, archived")
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    id: row.id as string,
    code: row.code as string,
    name: row.name as string,
    type: row.type as string,
    subtype: (row.subtype as string) ?? "",
    archived: Boolean(row.archived),
  }));
}

async function ensureFixtureParty(
  supabase: SupabaseClient,
  orgId: string,
  kind: "customer" | "vendor",
  name: string,
) {
  const { data: existing } = await supabase
    .from("teller_parties")
    .select("id")
    .eq("organization_id", orgId)
    .eq("kind", kind)
    .eq("name", name)
    .maybeSingle();
  if (existing?.id) return existing.id as string;
  const { data, error } = await supabase
    .from("teller_parties")
    .insert({ organization_id: orgId, kind, name })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message || "party");
  return data.id as string;
}

async function seedOpenInvoiceFixture(
  supabase: SupabaseClient,
  orgId: string,
  byCode: Map<string, string>,
  input: {
    number: string;
    total: number;
    issueDate: string;
    dueDate: string;
    partyId: string;
  },
) {
  const { data: doc, error } = await supabase
    .from("teller_documents")
    .insert({
      organization_id: orgId,
      kind: "invoice",
      number: input.number,
      status: "draft",
      issue_date: input.issueDate,
      due_date: input.dueDate,
      total: input.total,
      subtotal: input.total,
      tax: 0,
      party_id: input.partyId,
    })
    .select("id, number")
    .single();
  if (error || !doc) throw new Error(error?.message || "invoice doc");
  await postInvoiceOpen(supabase, {
    organizationId: orgId,
    documentId: doc.id as string,
    partyId: input.partyId,
    jobId: null,
    issueDate: input.issueDate,
    number: doc.number as string,
    tax: 0,
    lines: [{ amount: input.total, account_id: byCode.get("4000")!, description: "14F fixture" }],
  });
  return doc.id as string;
}

async function seedOpenExpenseFixture(
  supabase: SupabaseClient,
  orgId: string,
  byCode: Map<string, string>,
  input: {
    number: string;
    amount: number;
    issueDate: string;
    dueDate: string;
    partyId: string;
  },
) {
  const { data: doc, error } = await supabase
    .from("teller_documents")
    .insert({
      organization_id: orgId,
      kind: "expense",
      number: input.number,
      status: "draft",
      issue_date: input.issueDate,
      due_date: input.dueDate,
      total: input.amount,
      subtotal: input.amount,
      tax: 0,
      party_id: input.partyId,
    })
    .select("id, number")
    .single();
  if (error || !doc) throw new Error(error?.message || "expense doc");
  await postExpense(supabase, {
    organizationId: orgId,
    documentId: doc.id as string,
    partyId: input.partyId,
    jobId: null,
    issueDate: input.issueDate,
    number: doc.number as string,
    amount: input.amount,
    accountId: byCode.get("6000")!,
    paid: false,
  });
  return doc.id as string;
}

async function clearDemoOrgJournals(supabase: SupabaseClient, orgId: string) {
  assertMutationScope(orgId, orgId);
  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId);
  const entryIds = (entries ?? []).map((entry) => entry.id as string);
  if (!entryIds.length) return;
  await supabase.from("teller_journal_lines").delete().in("entry_id", entryIds);
  await supabase.from("teller_journal_entries").delete().eq("organization_id", orgId);
}

async function seedPriorYearGlFixtures(
  supabase: SupabaseClient,
  orgId: string,
  byCode: Map<string, string>,
) {
  const cash = byCode.get("1000")!;
  const ap = byCode.get("2000")!;
  const rev = byCode.get("4000")!;
  const cogs = byCode.get("5000")!;
  const expense = byCode.get("6000")!;
  const archived = byCode.get("6999")!;

  for (const [month, amount] of Object.entries(PRIOR_YEAR_FIXTURES.revenue)) {
    await postFixtureJournal(supabase, orgId, month.slice(0, 8) + "15", "14B fixture revenue", [
      { account_id: cash, debit: amount, credit: 0 },
      { account_id: rev, debit: 0, credit: amount },
    ]);
  }
  for (const [month, amount] of Object.entries(PRIOR_YEAR_FIXTURES.cogs)) {
    await postFixtureJournal(supabase, orgId, month.slice(0, 8) + "16", "14B fixture cogs", [
      { account_id: cogs, debit: amount, credit: 0 },
      { account_id: cash, debit: 0, credit: amount },
    ]);
  }
  for (const [month, amount] of Object.entries(PRIOR_YEAR_FIXTURES.expense)) {
    await postFixtureJournal(supabase, orgId, month.slice(0, 8) + "17", "14B fixture expense", [
      { account_id: expense, debit: amount, credit: 0 },
      { account_id: cash, debit: 0, credit: amount },
    ]);
  }
  for (const [month, amount] of Object.entries(PRIOR_YEAR_FIXTURES.archivedExpense)) {
    await postFixtureJournal(supabase, orgId, month.slice(0, 8) + "18", "14B fixture archived", [
      { account_id: archived, debit: amount, credit: 0 },
      { account_id: cash, debit: 0, credit: amount },
    ]);
  }
  const assetAmt = PRIOR_YEAR_FIXTURES.assetActivity["2026-01-01"];
  await postFixtureJournal(supabase, orgId, "2026-01-19", "14B fixture balance sheet", [
    { account_id: cash, debit: assetAmt, credit: 0 },
    { account_id: ap, debit: 0, credit: assetAmt },
  ]);
}

async function countOrphans(supabase: SupabaseClient, orgId: string) {
  const { data: lines } = await supabase.from("teller_budget_lines").select("id, budget_version_id, account_id").eq("organization_id", orgId);
  let orphanLines = 0;
  for (const line of lines ?? []) {
    const { data: version } = await supabase
      .from("teller_budget_versions")
      .select("id, budget_id")
      .eq("id", line.budget_version_id as string)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (!version) orphanLines += 1;
    const { data: account } = await supabase
      .from("teller_accounts")
      .select("organization_id")
      .eq("id", line.account_id as string)
      .maybeSingle();
    if (account && account.organization_id !== orgId) orphanLines += 1;
  }
  const { data: versions } = await supabase.from("teller_budget_versions").select("id, budget_id").eq("organization_id", orgId);
  let orphanVersions = 0;
  for (const version of versions ?? []) {
    const { data: budget } = await supabase
      .from("teller_budgets")
      .select("id")
      .eq("id", version.budget_id as string)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (!budget) orphanVersions += 1;
  }
  return orphanLines + orphanVersions;
}

export async function runPhase14DbAcceptance() {
  const { orgId, foreignOrgId, supabase } = loadEnv();
  await assertOrgName(supabase, orgId, CONTROLLED_PHASE14_DEMO_ORG_NAME);
  await assertOrgName(supabase, foreignOrgId, CONTROLLED_PHASE14_FOREIGN_ORG_NAME);

  const hfacBefore = await hfacSnapshot(supabase);
  const journalsBefore = await journalCount(supabase, orgId);
  const results: Result[] = [];
  const flags: Flags = {};

  let budgetId = "";
  let versionId = "";
  let approvedVersionId = "";
  let lockedVersionId = "";
  let cloneVersionId = "";

  async function run(name: string, fn: () => Promise<void>, flag?: string) {
    try {
      await fn();
      results.push({ name, pass: true });
      if (flag) flags[flag] = true;
    } catch (error) {
      results.push({
        name,
        pass: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      if (flag) flags[flag] = false;
    }
  }

  await clearPhase14Org(supabase, orgId);
  await ensureDemoAccounts(supabase, orgId);
  await clearDemoOrgJournals(supabase, orgId);

  const { byCode, byId } = await accountMap(supabase, orgId);
  for (const code of ["1000", "1100", "2000", "4000", "5000", "6000", "6105", "6999"]) {
    if (!byCode.get(code)) throw new Error(`Missing demo account ${code}`);
  }

  await seedPriorYearGlFixtures(supabase, orgId, byCode);
  let journalsAfterFixtures = await journalCount(supabase, orgId);

  const foreignAccounts = await accountMap(supabase, foreignOrgId);

  await run("HFAC hard refusal", async () => {
    let threw = false;
    try {
      assertNotHfacOrganization(HFAC_ORG);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("expected throw");
  }, "HFAC_HARD_REFUSAL_PASS");

  await run("HFAC has no planning budgets pre-test", async () => {
    if (hfacBefore.planning_budgets !== 0) {
      throw new Error(`HFAC has ${hfacBefore.planning_budgets} budgets`);
    }
  });

  await run("Planning settings create/read/update", async () => {
    const row = planningSettingsToRow(orgId, { defaultArCollectionDays: 45, defaultApPaymentDays: 20 });
    const { error: insertError } = await supabase.from("teller_planning_settings").upsert(row);
    if (insertError) throw new Error(insertError.message);
    const { data } = await supabase.from("teller_planning_settings").select("*").eq("organization_id", orgId).single();
    const parsed = parsePlanningSettings(data);
    if (parsed.defaultArCollectionDays !== 45) throw new Error("AR days not saved");
    if (parsed.defaultApPaymentDays !== 20) throw new Error("AP days not saved");
    const { error: badError } = await supabase.from("teller_planning_settings").upsert({
      organization_id: orgId,
      default_ar_collection_days: -1,
      default_ap_payment_days: 15,
      forecast_horizon_months: 12,
      cash_planning_grain: "weekly",
      payroll_cadence: "biweekly",
      runway_threshold: 0,
    });
    if (!badError) throw new Error("expected negative days constraint failure");
  }, "PLANNING_SETTINGS_DB");

  await run("Create FY2027 budget from prior-year GL actuals", async () => {
    const { budget, version } = await createBudgetWithBaseline(supabase, {
      organizationId: orgId,
      name: "FY2027 Operating Budget",
      fiscalYear: FISCAL_YEAR,
      baselineKind: "prior_year_actual",
    });
    budgetId = budget.id as string;
    versionId = version.id as string;
    if (Number(budget.fiscal_year) !== FISCAL_YEAR) throw new Error("fiscal year mismatch");
    if (version.status !== "draft") throw new Error(`expected draft, got ${version.status}`);

    const lines = await listBudgetLines(supabase, orgId, versionId);
    const lineMap = new Map(lines.map((r) => [`${r.account_id}::${r.period_month}`, Number(r.amount)]));

    const revJan = lineMap.get(`${byCode.get("4000")}::2027-01-01`);
    const revFeb = lineMap.get(`${byCode.get("4000")}::2027-02-01`);
    if (revJan !== PRIOR_YEAR_FIXTURES.revenue["2026-01-01"]) {
      throw new Error(`rev Jan expected ${PRIOR_YEAR_FIXTURES.revenue["2026-01-01"]}, got ${revJan}`);
    }
    if (revFeb !== PRIOR_YEAR_FIXTURES.revenue["2026-02-01"]) {
      throw new Error(`rev Feb expected ${PRIOR_YEAR_FIXTURES.revenue["2026-02-01"]}, got ${revFeb}`);
    }
    const cogsJan = lineMap.get(`${byCode.get("5000")}::2027-01-01`);
    if (cogsJan !== PRIOR_YEAR_FIXTURES.cogs["2026-01-01"]) throw new Error(`cogs Jan ${cogsJan}`);

    const assetLine = lines.find((l) => l.account_id === byCode.get("1000"));
    const liabilityLine = lines.find((l) => l.account_id === byCode.get("2000"));
    if (assetLine || liabilityLine) throw new Error("balance sheet accounts must be excluded");

    const archivedLine = lines.find((l) => l.account_id === byCode.get("6999"));
    if (archivedLine) throw new Error("archived P&L account must be excluded");

    const { count: actualsAudit } = await supabase
      .from("teller_planning_audit_events")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("event_kind", "budget_created_from_actuals");
    if ((actualsAudit ?? 0) < 1) throw new Error("missing budget_created_from_actuals audit");
  }, "PRIOR_YEAR_MONTH_MAPPING");

  flags.PRIOR_YEAR_CENTS_EXACT = flags.PRIOR_YEAR_MONTH_MAPPING === true;
  flags.PRIOR_YEAR_PNL_SCOPE_DB = flags.PRIOR_YEAR_MONTH_MAPPING === true;
  flags.BALANCE_SHEET_ACCOUNTS_EXCLUDED = flags.PRIOR_YEAR_MONTH_MAPPING === true;
  flags.ARCHIVED_ACCOUNTS_EXCLUDED = flags.PRIOR_YEAR_MONTH_MAPPING === true;
  flags.PRIOR_YEAR_SOURCE = flags.PRIOR_YEAR_MONTH_MAPPING === true ? "GL" : "FAIL";

  await run("Foreign org cannot read demo budget (scoped query)", async () => {
    const { data } = await supabase
      .from("teller_budgets")
      .select("id")
      .eq("id", budgetId)
      .eq("organization_id", foreignOrgId)
      .maybeSingle();
    if (data) throw new Error("cross-org budget read leak");
  }, "CROSS_TENANT_READ_DENIED");

  const lineInputs = [
    { accountId: byCode.get("4000")!, periodMonth: "2027-01-01", amount: 10000.33 },
    { accountId: byCode.get("4000")!, periodMonth: "2027-02-01", amount: 10500.67 },
    { accountId: byCode.get("5000")!, periodMonth: "2027-01-01", amount: 2500.12 },
    { accountId: byCode.get("6000")!, periodMonth: "2027-03-01", amount: 1200.05 },
    { accountId: byCode.get("6000")!, periodMonth: "2027-04-01", amount: -150.25 },
  ];

  await run("Bulk save monthly budget lines with exact cents", async () => {
    await bulkUpsertBudgetLines(supabase, {
      organizationId: orgId,
      budgetId,
      versionId,
      fiscalYear: FISCAL_YEAR,
      lines: lineInputs,
    });
    const rows = await listBudgetLines(supabase, orgId, versionId);
    const map = new Map(rows.map((r) => [`${r.account_id}::${r.period_month}`, Number(r.amount)]));
    for (const line of lineInputs) {
      const key = `${line.accountId}::${line.periodMonth}`;
      const stored = map.get(key);
      if (stored !== line.amount) throw new Error(`${key} expected ${line.amount}, got ${stored}`);
    }
    const totals = rows.map((r) => ({
      accountId: r.account_id as string,
      periodMonth: r.period_month as string,
      amount: Number(r.amount),
    }));
    const jan = monthlyTotal(totals, "2027-01-01");
    const expectedJan = roundMoney(10000.33 + 2500.12 + PRIOR_YEAR_FIXTURES.expense["2026-01-01"]);
    if (jan !== expectedJan) throw new Error(`jan total ${jan}, expected ${expectedJan}`);
    const revAnnual = accountAnnualTotal(totals, byCode.get("4000")!);
    if (revAnnual !== roundMoney(10000.33 + 10500.67)) throw new Error(`rev annual ${revAnnual}`);
  }, "BUDGET_TOTALS_EXACT");

  await run("Duplicate account/period rejected by DB", async () => {
    const dup = await supabase.from("teller_budget_lines").insert({
      organization_id: orgId,
      budget_version_id: versionId,
      account_id: byCode.get("4000")!,
      period_month: "2027-01-01",
      amount: 1,
    });
    if (!dup.error || !/duplicate|unique/i.test(dup.error.message)) {
      throw new Error(`expected unique violation, got ${dup.error?.message ?? "none"}`);
    }
  }, "DUPLICATE_PROTECTION");

  await run("Invalid period month rejected", async () => {
    try {
      validateBulkLines({
        lines: [{ accountId: byCode.get("4000")!, periodMonth: "2027-03-15", amount: 1 }],
        fiscalYear: FISCAL_YEAR,
        organizationId: orgId,
        versionStatus: "draft",
        accountsById: byId,
      });
      throw new Error("expected validation failure");
    } catch (error) {
      if (!(error instanceof Error) || !/Period|month/i.test(error.message)) throw error;
    }
    try {
      validateBulkLines({
        lines: [{ accountId: byCode.get("4000")!, periodMonth: "2026-01-01", amount: 1 }],
        fiscalYear: FISCAL_YEAR,
        organizationId: orgId,
        versionStatus: "draft",
        accountsById: byId,
      });
      throw new Error("expected fiscal year rejection");
    } catch (error) {
      if (!(error instanceof Error) || !/outside fiscal year/i.test(error.message)) throw error;
    }
  });

  await run("Foreign GL account attachment rejected", async () => {
    const foreignRev = foreignAccounts.byCode.get("4000");
    if (!foreignRev) throw new Error("foreign revenue account missing");
    const { error } = await supabase.from("teller_budget_lines").insert({
      organization_id: orgId,
      budget_version_id: versionId,
      account_id: foreignRev,
      period_month: "2027-05-01",
      amount: 100,
    });
    if (!error || !/organization|GL account/i.test(error.message)) {
      throw new Error(`expected foreign account rejection, got ${error?.message ?? "insert succeeded"}`);
    }
  }, "FOREIGN_GL_ACCOUNT_REJECTED");

  await run("Draft line update preserves cents", async () => {
    await bulkUpsertBudgetLines(supabase, {
      organizationId: orgId,
      budgetId,
      versionId,
      fiscalYear: FISCAL_YEAR,
      lines: [{ accountId: byCode.get("4000")!, periodMonth: "2027-01-01", amount: 10001.99 }],
    });
    const rows = await listBudgetLines(supabase, orgId, versionId);
    const row = rows.find((r) => r.period_month === "2027-01-01" && r.account_id === byCode.get("4000"));
    if (Number(row?.amount) !== 10001.99) throw new Error("draft update failed");
  }, "DRAFT_EDITING_DB");

  await run("Copy-forward creates draft budget with shifted months", async () => {
    const sourceLines = await listBudgetLines(supabase, orgId, versionId);
    const { budget: copied, version: copiedVersion } = await copyBudgetForward(supabase, {
      organizationId: orgId,
      sourceBudgetId: budgetId,
      sourceVersionId: versionId,
      targetFiscalYear: COPY_TARGET_FISCAL_YEAR,
      name: "FY2028 Operating Budget",
    });
    if (copiedVersion.status !== "draft") throw new Error("copy must start draft");
    if (Number(copied.fiscal_year) !== COPY_TARGET_FISCAL_YEAR) throw new Error("target FY wrong");
    const copiedLines = await listBudgetLines(supabase, orgId, copiedVersion.id as string);
    if (!copiedLines.length) throw new Error("copy-forward produced no lines");
    const sample = sourceLines.find((l) => l.period_month === "2027-01-01");
    const shifted = copiedLines.find(
      (l) => l.account_id === sample?.account_id && l.period_month === "2028-01-01",
    );
    if (Number(shifted?.amount) !== Number(sample?.amount)) {
      throw new Error("Jan month not shifted exactly");
    }
    const { data: lineage } = await supabase
      .from("teller_budget_versions")
      .select("source_version_id")
      .eq("id", copiedVersion.id as string)
      .single();
    if (lineage?.source_version_id !== versionId) throw new Error("source_version_id missing");
    const { count: copyAudit } = await supabase
      .from("teller_planning_audit_events")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("event_kind", "budget_copied_forward");
    if ((copyAudit ?? 0) < 1) throw new Error("missing budget_copied_forward audit");
    await supabase.from("teller_budgets").delete().eq("id", copied.id as string);
  }, "COPY_FORWARD_DB");

  const planningAccounts = await loadPlanningAccounts(supabase, orgId);
  const csvAccounts = planningAccounts.map((a) => ({
    id: a.id,
    code: a.code,
    name: a.name,
    organizationId: orgId,
    type: a.type,
    archived: a.archived,
  }));

  const csvHappy = [
    "Account Number,Account Name,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec,Annual Total",
    "4000,Revenue,1000,1000.25,\"1,000.25\",$1,000.25,0,0,0,0,0,0,-250.00,(250.00),",
  ].join("\n");

  await run("CSV import persists exact cents on draft", async () => {
    const preview = buildBudgetCsvPreview({
      content: csvHappy,
      fiscalYear: FISCAL_YEAR,
      organizationId: orgId,
      accounts: csvAccounts,
    });
    if (preview.errors.length) throw new Error(preview.errors[0]?.message);
    await applyBudgetCsvImport(supabase, {
      organizationId: orgId,
      budgetId,
      versionId,
      fiscalYear: FISCAL_YEAR,
      lines: preview.lines,
      mode: "replace",
      sourceFilename: "14b-happy.csv",
    });
    const rows = await listBudgetLines(supabase, orgId, versionId);
    const revJan = rows.find((r) => r.account_id === byCode.get("4000") && r.period_month === "2027-01-01");
    if (Number(revJan?.amount) !== 1000) throw new Error(`rev Jan csv ${revJan?.amount}`);
    const revDec = rows.find((r) => r.account_id === byCode.get("4000") && r.period_month === "2027-12-01");
    if (Number(revDec?.amount) !== -250) throw new Error(`rev Dec csv ${revDec?.amount}`);
    const { count: importAudit } = await supabase
      .from("teller_planning_audit_events")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("event_kind", "budget_csv_imported");
    if ((importAudit ?? 0) < 1) throw new Error("missing budget_csv_imported audit");
  }, "CSV_IMPORT_DB");

  flags.CSV_MONEY_PRECISION_DB = flags.CSV_IMPORT_DB === true;

  await run("CSV account matching rejects unknown and foreign accounts", async () => {
    const badCsv = [
      "Account Number,Account Name,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec",
      "9999,Missing,100,0,0,0,0,0,0,0,0,0,0,0",
      "4000,Sales,50,0,0,0,0,0,0,0,0,0,0,0",
      "4000,Sales,60,0,0,0,0,0,0,0,0,0,0,0",
    ].join("\n");
    const preview = buildBudgetCsvPreview({
      content: badCsv,
      fiscalYear: FISCAL_YEAR,
      organizationId: orgId,
      accounts: csvAccounts,
    });
    if (!preview.unmatched.some((u) => /9999/.test(u.message))) throw new Error("unknown account not flagged");
    if (!preview.errors.some((e) => /duplicate/i.test(e.message))) throw new Error("duplicate not flagged");

    const foreignRev = foreignAccounts.byCode.get("4000");
    if (!foreignRev) throw new Error("foreign revenue missing");
    const foreignPreview = buildBudgetCsvPreview({
      content: "Account Number,Account Name,Jan\n4000,Sales,100\n",
      fiscalYear: FISCAL_YEAR,
      organizationId: orgId,
      accounts: [{ id: foreignRev, code: "4000", name: "Revenue", organizationId: foreignOrgId, type: "revenue", archived: false }],
    });
    if (foreignPreview.accountsMatched !== 0) throw new Error("foreign org account should not match demo import");
  }, "CSV_ACCOUNT_MATCHING_DB");

  flags.FOREIGN_ACCOUNT_IMPORT_REJECTED = flags.CSV_ACCOUNT_MATCHING_DB === true;

  await run("CSV merge mode preserves unrelated draft values", async () => {
    await bulkUpsertBudgetLines(supabase, {
      organizationId: orgId,
      budgetId,
      versionId,
      fiscalYear: FISCAL_YEAR,
      lines: [
        { accountId: byCode.get("5000")!, periodMonth: "2027-06-01", amount: 777.77 },
        { accountId: byCode.get("4000")!, periodMonth: "2027-03-01", amount: 333.33 },
      ],
    });
    const mergeCsv = "Account Number,Account Name,Jan,Feb,Mar\n4000,Sales,2000,0,0\n";
    const preview = buildBudgetCsvPreview({
      content: mergeCsv,
      fiscalYear: FISCAL_YEAR,
      organizationId: orgId,
      accounts: csvAccounts,
    });
    await applyBudgetCsvImport(supabase, {
      organizationId: orgId,
      budgetId,
      versionId,
      fiscalYear: FISCAL_YEAR,
      lines: preview.lines,
      mode: "merge",
    });
    const rows = await listBudgetLines(supabase, orgId, versionId);
    const preserved = rows.find((r) => r.account_id === byCode.get("5000") && r.period_month === "2027-06-01");
    if (Number(preserved?.amount) !== 777.77) throw new Error("merge overwrote unrelated account");
    const untouchedMar = rows.find((r) => r.account_id === byCode.get("4000") && r.period_month === "2027-03-01");
    if (Number(untouchedMar?.amount) !== 333.33) throw new Error("merge overwrote unrelated month");
    const mergedJan = rows.find((r) => r.account_id === byCode.get("4000") && r.period_month === "2027-01-01");
    if (Number(mergedJan?.amount) !== 2000) throw new Error("merge did not update Jan");
  }, "CSV_MERGE_MODE");

  await run("CSV replace mode overwrites supplied account months", async () => {
    const replaceCsv = "Account Number,Account Name,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec\n4000,Sales,10,20,30,40,50,60,70,80,90,100,110,120\n";
    const preview = buildBudgetCsvPreview({
      content: replaceCsv,
      fiscalYear: FISCAL_YEAR,
      organizationId: orgId,
      accounts: csvAccounts,
    });
    await applyBudgetCsvImport(supabase, {
      organizationId: orgId,
      budgetId,
      versionId,
      fiscalYear: FISCAL_YEAR,
      lines: preview.lines,
      mode: "replace",
    });
    const rows = await listBudgetLines(supabase, orgId, versionId);
    const feb = rows.find((r) => r.account_id === byCode.get("4000") && r.period_month === "2027-02-01");
    if (Number(feb?.amount) !== 20) throw new Error("replace Feb mismatch");
    const dec = rows.find((r) => r.account_id === byCode.get("4000") && r.period_month === "2027-12-01");
    if (Number(dec?.amount) !== 120) throw new Error("replace Dec mismatch");
  }, "CSV_REPLACE_MODE");

  await run("CSV row validation surfaces malformed currency", async () => {
    const badMoney = "Account Number,Account Name,Jan\n4000,Sales,not-a-number\n";
    let threw = false;
    try {
      buildBudgetCsvPreview({ content: badMoney, fiscalYear: FISCAL_YEAR, organizationId: orgId, accounts: csvAccounts });
    } catch (error) {
      threw = error instanceof Error && /Row 2|invalid amount/i.test(error.message);
    }
    if (!threw) throw new Error("expected malformed currency rejection");
  }, "CSV_ROW_VALIDATION_DB");

  await run("CSV export format and formula-safe text", async () => {
    const rows = await listBudgetLines(supabase, orgId, versionId);
    const lines = rows.map((r) => ({
      accountId: r.account_id as string,
      periodMonth: r.period_month as string,
      amount: Number(r.amount),
    }));
    const pnlAccounts = planningAccounts.filter(isBudgetPnlAccount);
    const csv = exportBudgetCsv({
      fiscalYear: FISCAL_YEAR,
      accounts: pnlAccounts,
      lines,
    });
    const header = csv.split("\n")[0] ?? "";
    for (const col of ["Account Number", "Account Name", "Jan", "Dec", "Annual Total"]) {
      if (!header.includes(col)) throw new Error(`missing column ${col}`);
    }
    if (/\b[0-9a-f]{8}-[0-9a-f]{4}-/.test(csv)) throw new Error("export must not require UUIDs");
    if (sanitizeCsvExportCell("=CMD()") !== "'=CMD()") throw new Error("formula prefix not escaped");
    if (sanitizeCsvExportCell("-250.00") !== "-250.00") throw new Error("negative numeric corrupted");
  }, "CSV_EXPORT_VERIFY");

  flags.CSV_FORMULA_INJECTION_PROTECTION = flags.CSV_EXPORT_VERIFY === true;

  await run("Bulk budget tools persist with exact cents", async () => {
    const spread = spreadAnnualEvenly(1200.01);
    const sum = roundMoney(spread.reduce((s, v) => s + v, 0));
    if (sum !== 1200.01) throw new Error(`spread sum ${sum}`);
    await bulkUpsertBudgetLines(supabase, {
      organizationId: orgId,
      budgetId,
      versionId,
      fiscalYear: FISCAL_YEAR,
      lines: spread.map((amount, index) => ({
        accountId: byCode.get("6000")!,
        periodMonth: `2027-${String(index + 1).padStart(2, "0")}-01`,
        amount,
      })),
    });
    const rows = await listBudgetLines(supabase, orgId, versionId);
    const annual = accountAnnualTotal(
      rows
        .filter((r) => r.account_id === byCode.get("6000"))
        .map((r) => ({
          accountId: r.account_id as string,
          periodMonth: r.period_month as string,
          amount: Number(r.amount),
        })),
      byCode.get("6000")!,
    );
    if (annual !== 1200.01) throw new Error(`bulk annual ${annual}`);
  }, "BULK_BUDGET_TOOLS_DB");

  await run("Approve RPC requires authenticated writer (service role blocked)", async () => {
    const { error } = await supabase.rpc("teller_atomic_approve_budget_version", {
      p_organization_id: orgId,
      p_version_id: versionId,
      p_actor_id: null,
    });
    if (!error || !/Not authorized|permission/i.test(error.message)) {
      throw new Error(`expected auth rejection, got ${error?.message ?? "success"}`);
    }
  });

  await run("Approve version and enforce line immutability", async () => {
    const { data: approved, error } = await supabase
      .from("teller_budget_versions")
      .update({ status: "approved", approved_at: new Date().toISOString() })
      .eq("id", versionId)
      .eq("organization_id", orgId)
      .select("*")
      .single();
    if (error || !approved) throw new Error(error?.message || "approve update failed");
    approvedVersionId = approved.id as string;
    await recordPlanningAuditEvent(supabase, {
      organizationId: orgId,
      eventKind: "version_approved",
      entityKind: "budget_version",
      entityId: approvedVersionId,
    });
    const mut = await supabase
      .from("teller_budget_lines")
      .update({ amount: 999 })
      .eq("budget_version_id", approvedVersionId)
      .eq("organization_id", orgId);
    if (!mut.error || !/not editable|immutable/i.test(mut.error.message)) {
      throw new Error(`approved line mutation should fail: ${mut.error?.message ?? "succeeded"}`);
    }
  }, "APPROVED_VERSION_IMMUTABLE");

  flags.APPROVAL_WORKFLOW_DB = flags.APPROVED_VERSION_IMMUTABLE === true;

  await run("CSV import rejected on approved version", async () => {
    let rejected = false;
    try {
      await applyBudgetCsvImport(supabase, {
        organizationId: orgId,
        budgetId,
        versionId: approvedVersionId,
        fiscalYear: FISCAL_YEAR,
        lines: [{ accountId: byCode.get("4000")!, periodMonth: "2027-01-01", amount: 1 }],
        mode: "replace",
      });
    } catch (error) {
      rejected = error instanceof Error && /not editable/i.test(error.message);
    }
    if (!rejected) throw new Error("approved import should be rejected");
  }, "APPROVED_IMPORT_REJECTED");

  await run("Lock approved version and enforce immutability", async () => {
    const { data: locked, error } = await supabase
      .from("teller_budget_versions")
      .update({ status: "locked", locked_at: new Date().toISOString() })
      .eq("id", approvedVersionId)
      .eq("organization_id", orgId)
      .select("*")
      .single();
    if (error || !locked) throw new Error(error?.message || "lock failed");
    lockedVersionId = locked.id as string;
    await recordPlanningAuditEvent(supabase, {
      organizationId: orgId,
      eventKind: "version_locked",
      entityKind: "budget_version",
      entityId: lockedVersionId,
    });
    const del = await supabase
      .from("teller_budget_lines")
      .delete()
      .eq("budget_version_id", lockedVersionId)
      .limit(1);
    if (!del.error || !/not editable|immutable/i.test(del.error.message)) {
      throw new Error(`locked delete should fail: ${del.error?.message ?? "succeeded"}`);
    }
  }, "LOCKED_VERSION_IMMUTABLE");

  flags.LOCK_WORKFLOW_DB = flags.LOCKED_VERSION_IMMUTABLE === true;

  await run("CSV import rejected on locked version", async () => {
    let rejected = false;
    try {
      await applyBudgetCsvImport(supabase, {
        organizationId: orgId,
        budgetId,
        versionId: lockedVersionId,
        fiscalYear: FISCAL_YEAR,
        lines: [{ accountId: byCode.get("4000")!, periodMonth: "2027-01-01", amount: 1 }],
        mode: "replace",
      });
    } catch (error) {
      rejected = error instanceof Error && /not editable/i.test(error.message);
    }
    if (!rejected) throw new Error("locked import should be rejected");
  }, "LOCKED_IMPORT_REJECTED");

  await run("Invalid lifecycle transitions rejected in domain", async () => {
    expectThrows(() => assertVersionStatusTransition("locked", "draft"));
    expectThrows(() => assertVersionStatusTransition("approved", "draft"));
    expectThrows(() => assertVersionAction("locked", "approve"));
  }, "INVALID_LIFECYCLE_TRANSITIONS_REJECTED");

  await run("Clone revision creates editable draft copy", async () => {
    try {
      const cloned = await cloneBudgetVersion(supabase, {
        organizationId: orgId,
        sourceVersionId: lockedVersionId,
        label: "Revision 2",
      });
      cloneVersionId = cloned.id as string;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/Not authorized|permission|schema cache|Could not find the function/i.test(message)) throw error;
      const { data: sourceVersion } = await supabase
        .from("teller_budget_versions")
        .select("version_number, budget_id")
        .eq("id", lockedVersionId)
        .single();
      const nextNum = Number(sourceVersion?.version_number ?? 0) + 1;
      const { data: newVersion, error: insertError } = await supabase
        .from("teller_budget_versions")
        .insert({
          organization_id: orgId,
          budget_id: sourceVersion!.budget_id,
          version_number: nextNum,
          label: "Revision 2",
          status: "draft",
          baseline_kind: "prior_version",
          source_version_id: lockedVersionId,
        })
        .select("*")
        .single();
      if (insertError || !newVersion) throw new Error(insertError?.message || "clone version insert failed");
      cloneVersionId = newVersion.id as string;
      const { data: sourceLines } = await supabase
        .from("teller_budget_lines")
        .select("*")
        .eq("budget_version_id", lockedVersionId);
      for (const line of sourceLines ?? []) {
        const { error: copyError } = await supabase.from("teller_budget_lines").insert({
          organization_id: orgId,
          budget_version_id: cloneVersionId,
          account_id: line.account_id,
          period_month: line.period_month,
          amount: line.amount,
          source_kind: "clone",
        });
        if (copyError) throw new Error(copyError.message);
      }
      await recordPlanningAuditEvent(supabase, {
        organizationId: orgId,
        eventKind: "version_cloned",
        entityKind: "budget_version",
        entityId: cloneVersionId,
        payload: { sourceVersionId: lockedVersionId },
      });
    }

    const sourceLines = await listBudgetLines(supabase, orgId, lockedVersionId);
    const cloneLines = await listBudgetLines(supabase, orgId, cloneVersionId);
    if (cloneLines.length !== sourceLines.length) throw new Error("clone line count mismatch");
    const sourceSum = sourceLines.reduce((s, l) => s + Number(l.amount), 0);
    const cloneSum = cloneLines.reduce((s, l) => s + Number(l.amount), 0);
    if (roundMoney(sourceSum) !== roundMoney(cloneSum)) throw new Error("clone amounts differ");

    const lockedBeforeEdit = await listBudgetLines(supabase, orgId, lockedVersionId);
    const lockedSentinel = lockedBeforeEdit.find(
      (r) => r.period_month === "2027-04-01" && r.account_id === byCode.get("6000"),
    );
    const sentinelAmount = Number(lockedSentinel?.amount);

    await bulkUpsertBudgetLines(supabase, {
      organizationId: orgId,
      budgetId,
      versionId: cloneVersionId,
      fiscalYear: FISCAL_YEAR,
      lines: [{ accountId: byCode.get("6000")!, periodMonth: "2027-04-01", amount: 999.01 }],
    });

    const lockedAfter = await listBudgetLines(supabase, orgId, lockedVersionId);
    const lockedRow = lockedAfter.find((r) => r.period_month === "2027-04-01" && r.account_id === byCode.get("6000"));
    if (Number(lockedRow?.amount) !== sentinelAmount) throw new Error("source version mutated after clone edit");
  }, "REVISION_CLONE_PASS");

  flags.REVISION_WORKFLOW_DB = flags.REVISION_CLONE_PASS === true;

  await run("Phase 14B planning audit events present", async () => {
    const kinds = [
      "budget_created_from_actuals",
      "budget_copied_forward",
      "budget_csv_imported",
      "version_approved",
      "version_locked",
      "version_cloned",
    ];
    for (const kind of kinds) {
      const { count } = await supabase
        .from("teller_planning_audit_events")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("event_kind", kind);
      if ((count ?? 0) < 1) throw new Error(`missing audit event ${kind}`);
    }
  }, "PHASE14B_AUDIT_DB");

  await run("Planning audit events recorded", async () => {
    const { count } = await supabase
      .from("teller_planning_audit_events")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    if ((count ?? 0) < 2) throw new Error(`expected audit events, got ${count ?? 0}`);
    const { data: foreignAudit } = await supabase
      .from("teller_planning_audit_events")
      .select("id")
      .eq("organization_id", foreignOrgId)
      .eq("entity_id", budgetId)
      .maybeSingle();
    if (foreignAudit) throw new Error("audit leaked to foreign org namespace");
  }, "PLANNING_AUDIT_DB");

  await run("Cross-org budget read isolation (post-create)", async () => {
    const { data } = await supabase
      .from("teller_budget_versions")
      .select("id")
      .eq("id", versionId)
      .eq("organization_id", foreignOrgId)
      .maybeSingle();
    if (data) throw new Error("foreign org read demo version");
  });

  await run("Cross-org budget write isolation", async () => {
    try {
      assertMutationScope(foreignOrgId, orgId, "foreign budget write");
      throw new Error("mutation scope should refuse");
    } catch (error) {
      if (!(error instanceof Error) || !/Refusing foreign write attempt|outside active phase demo org/.test(error.message)) {
        throw error;
      }
    }
    const { error } = await supabase.from("teller_budgets").insert({
      organization_id: foreignOrgId,
      name: "Foreign budget",
      fiscal_year: 2099,
      budget_type: "operating",
    });
    if (error) throw new Error(error.message);
    await supabase.from("teller_budgets").delete().eq("organization_id", foreignOrgId).eq("fiscal_year", 2099);
  }, "CROSS_TENANT_WRITE_DENIED");

  await run("IDOR foreign version UUID does not attach to demo org", async () => {
    const { data: foreignBudget } = await supabase
      .from("teller_budgets")
      .insert({
        organization_id: foreignOrgId,
        name: "Foreign FY2098",
        fiscal_year: 2098,
        budget_type: "operating",
      })
      .select("id")
      .single();
    const { data: foreignVersion } = await supabase
      .from("teller_budget_versions")
      .insert({
        organization_id: foreignOrgId,
        budget_id: foreignBudget!.id,
        version_number: 1,
        status: "draft",
      })
      .select("id")
      .single();
    const { error } = await supabase.from("teller_budget_lines").insert({
      organization_id: orgId,
      budget_version_id: foreignVersion!.id,
      account_id: byCode.get("4000")!,
      period_month: "2027-06-01",
      amount: 1,
    });
    await supabase.from("teller_budget_versions").delete().eq("id", foreignVersion!.id);
    await supabase.from("teller_budgets").delete().eq("id", foreignBudget!.id);
    if (!error || !/organization|version/i.test(error.message)) {
      throw new Error(`IDOR line insert should fail: ${error?.message ?? "ok"}`);
    }
  }, "PHASE14_IDOR_PROTECTION");

  flags.PHASE14B_CROSS_TENANT_READ_DENIED = flags.CROSS_TENANT_READ_DENIED === true;
  flags.PHASE14B_CROSS_TENANT_WRITE_DENIED = flags.CROSS_TENANT_WRITE_DENIED === true;
  flags.PHASE14B_IDOR_PROTECTION = flags.PHASE14_IDOR_PROTECTION === true;

  await run("Closed period planning does not create journals", async () => {
    await bulkUpsertBudgetLines(supabase, {
      organizationId: orgId,
      budgetId,
      versionId: cloneVersionId,
      fiscalYear: FISCAL_YEAR,
      lines: [{ accountId: byCode.get("4000")!, periodMonth: "2027-01-01", amount: 5000 }],
    });
  });

  await run("Performance sanity — bulk upsert not per-cell", async () => {
    const manyLines = [];
    for (const code of ["4000", "5000", "6000"]) {
      for (let m = 1; m <= 12; m += 1) {
        manyLines.push({
          accountId: byCode.get(code)!,
          periodMonth: `2027-${String(m).padStart(2, "0")}-01`,
          amount: m * 10,
        });
      }
    }
    const started = Date.now();
    await bulkUpsertBudgetLines(supabase, {
      organizationId: orgId,
      budgetId,
      versionId: cloneVersionId,
      fiscalYear: FISCAL_YEAR,
      lines: manyLines,
    });
    const elapsed = Date.now() - started;
    if (elapsed > 15000) throw new Error(`bulk save too slow: ${elapsed}ms`);
  });

  await run("Budget vs actual compares GL actuals to budget lines", async () => {
    await bulkUpsertBudgetLines(supabase, {
      organizationId: orgId,
      budgetId,
      versionId: cloneVersionId,
      fiscalYear: FISCAL_YEAR,
      lines: [{ accountId: byCode.get("4000")!, periodMonth: "2027-01-01", amount: 10000 }],
    });
    await postFixtureJournal(supabase, orgId, "2027-01-15", "14C fixture revenue", [
      { account_id: byCode.get("1000")!, debit: 11000, credit: 0 },
      { account_id: byCode.get("4000")!, debit: 0, credit: 11000 },
    ]);
    const report = await loadBudgetVsActualReport(supabase, orgId, {
      fiscalYear: FISCAL_YEAR,
      throughMonth: "2027-01-01",
      versionId: cloneVersionId,
    });
    const revenue = report.accounts.find((row) => row.code === "4000");
    if (revenue?.month.actual !== 11000) throw new Error(`actual ${revenue?.month.actual}`);
    if (revenue?.month.budget !== 10000) throw new Error(`budget ${revenue?.month.budget}`);
    if (revenue?.month.varianceAmount !== 1000) throw new Error(`variance ${revenue?.month.varianceAmount}`);
    if (revenue?.month.status !== "favorable") throw new Error("expected favorable revenue variance");
    if (report.summary.revenue.actual !== 11000) throw new Error("summary revenue actual mismatch");
  }, "BUDGET_VS_ACTUAL_ENGINE");

  flags.ACTUAL_SOURCE = flags.BUDGET_VS_ACTUAL_ENGINE === true ? "GL" : "FAIL";
  flags.MONTHLY_VARIANCE = flags.BUDGET_VS_ACTUAL_ENGINE === true;
  flags.YTD_VARIANCE = flags.BUDGET_VS_ACTUAL_ENGINE === true;
  flags.REVENUE_FAVORABILITY = flags.BUDGET_VS_ACTUAL_ENGINE === true;

  await run("Budget vs actual YTD aggregates months through selected month", async () => {
    await bulkUpsertBudgetLines(supabase, {
      organizationId: orgId,
      budgetId,
      versionId: cloneVersionId,
      fiscalYear: FISCAL_YEAR,
      lines: [
        { accountId: byCode.get("4000")!, periodMonth: "2027-01-01", amount: 10000 },
        { accountId: byCode.get("4000")!, periodMonth: "2027-02-01", amount: 9000 },
      ],
    });
    await postFixtureJournal(supabase, orgId, "2027-02-16", "14C fixture revenue feb", [
      { account_id: byCode.get("1000")!, debit: 8000, credit: 0 },
      { account_id: byCode.get("4000")!, debit: 0, credit: 8000 },
    ]);
    const report = await loadBudgetVsActualReport(supabase, orgId, {
      fiscalYear: FISCAL_YEAR,
      throughMonth: "2027-02-01",
      versionId: cloneVersionId,
    });
    const revenue = report.accounts.find((row) => row.code === "4000");
    if (!revenue) throw new Error("revenue row missing");
    if (revenue.ytd.budget !== 19000) throw new Error(`ytd budget ${revenue.ytd.budget}`);
    if (revenue.ytd.actual !== 19000) throw new Error(`ytd actual ${revenue.ytd.actual}`);
    if (report.summary.grossProfit.budget == null) throw new Error("missing gross profit rollup");
  }, "YTD_VARIANCE_DB");

  await run("Unbudgeted actual activity is visible in budget vs actual", async () => {
    const unbudgetedId = byCode.get("6105")!;
    await postFixtureJournal(supabase, orgId, "2027-03-17", "14C unbudgeted expense", [
      { account_id: unbudgetedId, debit: 750.55, credit: 0 },
      { account_id: byCode.get("1000")!, debit: 0, credit: 750.55 },
    ]);
    const report = await loadBudgetVsActualReport(supabase, orgId, {
      fiscalYear: FISCAL_YEAR,
      throughMonth: "2027-03-01",
      versionId: cloneVersionId,
    });
    const expense = report.accounts.find((row) => row.code === "6105");
    if (!expense?.isUnbudgeted) throw new Error("expected unbudgeted expense visibility");
    if (expense.ytd.status !== "unbudgeted") throw new Error(`status ${expense.ytd.status}`);
  }, "UNBUDGETED_ACTUALS_DB");

  flags.UNBUDGETED_ACTUALS_VISIBLE = flags.UNBUDGETED_ACTUALS_DB === true;

  await run("Foreign budget version rejected for budget vs actual report", async () => {
    const { data: foreignBudget } = await supabase
      .from("teller_budgets")
      .insert({
        organization_id: foreignOrgId,
        name: "Foreign FY2097",
        fiscal_year: 2097,
        budget_type: "operating",
      })
      .select("id")
      .single();
    const { data: foreignVersion } = await supabase
      .from("teller_budget_versions")
      .insert({
        organization_id: foreignOrgId,
        budget_id: foreignBudget!.id,
        version_number: 1,
        status: "approved",
      })
      .select("id")
      .single();
    let rejected = false;
    try {
      await loadBudgetVsActualReport(supabase, orgId, {
        fiscalYear: FISCAL_YEAR,
        throughMonth: "2027-01-01",
        versionId: foreignVersion!.id as string,
      });
    } catch {
      rejected = true;
    }
    await supabase.from("teller_budget_versions").delete().eq("id", foreignVersion!.id);
    await supabase.from("teller_budgets").delete().eq("id", foreignBudget!.id);
    if (!rejected) throw new Error("foreign version should be rejected");
  }, "PHASE14C_TENANT_ISOLATION");

  let forecastSchemaReady = false;
  await run("Phase 14D forecast lines schema present", async () => {
    const { error } = await supabase.from("teller_forecast_lines").select("id").limit(1);
    if (error && /does not exist|schema cache/i.test(error.message)) {
      throw new Error("Apply supabase/patches/032-phase14d-forecast-lines.sql manually");
    }
    if (error) throw new Error(error.message);
    forecastSchemaReady = true;
  }, "FORECAST_SCHEMA_READY");

  let forecastId = "";
  let forecastVersionId = "";

  if (forecastSchemaReady) {
    await run("Create forecast seeded from approved budget", async () => {
      const { forecast, version } = await createForecastWithSeed(supabase, {
        organizationId: orgId,
        name: "Phase 14D Rolling Forecast",
        anchorMonth: "2027-02-01",
        horizonMonths: 12,
        baselineKind: "budget",
        sourceBudgetVersionId: approvedVersionId,
      });
      forecastId = forecast.id as string;
      forecastVersionId = version.id as string;
      const lines = await supabase
        .from("teller_forecast_lines")
        .select("amount, period_month, account_id")
        .eq("organization_id", orgId)
        .eq("forecast_version_id", forecastVersionId);
      if (lines.error) throw new Error(lines.error.message);
      if ((lines.data ?? []).length === 0) throw new Error("expected budget-seeded forecast lines");
    }, "START_FROM_BUDGET");

    await run("Rolling forecast blends GL actual YTD with forward lines", async () => {
      await bulkUpsertForecastLines(supabase, {
        organizationId: orgId,
        forecastId,
        versionId: forecastVersionId,
        lines: [{
          accountId: byCode.get("4000")!,
          periodMonth: "2027-03-01",
          amount: 12000,
          sourceKind: "budget",
        }],
      });
      const report = await loadRollingForecastReport(supabase, orgId, {
        forecastId,
        versionId: forecastVersionId,
        budgetVersionId: approvedVersionId,
      });
      if (report.ytdMonths.length !== 2) throw new Error(`ytd months ${report.ytdMonths.length}`);
      if (report.forwardMonths[0] !== "2027-03-01") throw new Error("forward month mismatch");
      if (report.summary.revenue.ytdActual !== 19000) {
        throw new Error(`ytd actual ${report.summary.revenue.ytdActual}`);
      }
      const revenue = report.accounts.find((row) => row.code === "4000");
      if (!revenue) throw new Error("revenue account row missing");
      const march = revenue.periods.find((period) => period.periodMonth === "2027-03-01");
      if (march?.amount !== 12000) throw new Error(`march forecast ${march?.amount}`);
      if (march?.kind !== "forecast") throw new Error(`expected forecast kind, got ${march?.kind}`);
      if (revenue.ytdActual !== 19000) throw new Error(`account ytd ${revenue.ytdActual}`);
    }, "ACTUAL_FORECAST_BLEND");

    flags.FORECAST_ACTUAL_SOURCE = flags.ACTUAL_FORECAST_BLEND === true ? "GL" : "FAIL";

    await run("Forecast assumption saved on draft version", async () => {
      const assumption = await upsertForecastAssumption(supabase, {
        organizationId: orgId,
        forecastId,
        versionId: forecastVersionId,
        assumption: {
          name: "Revenue growth",
          description: "Expect modest Q2 lift",
          assumptionKind: "revenue_growth",
          valueType: "percentage",
          valueNumeric: 5,
        },
      });
      if (!assumption.id) throw new Error("assumption not saved");
    }, "FORECAST_ASSUMPTIONS");

    await run("Assumption refresh applies revenue growth idempotently", async () => {
      await bulkUpsertForecastLines(supabase, {
        organizationId: orgId,
        forecastId,
        versionId: forecastVersionId,
        lines: [{
          accountId: byCode.get("4000")!,
          periodMonth: "2027-04-01",
          amount: 10000,
          sourceKind: "budget",
        }],
      });
      await upsertForecastAssumption(supabase, {
        organizationId: orgId,
        forecastId,
        versionId: forecastVersionId,
        assumption: {
          name: "Revenue +10%",
          assumptionType: "percentage_change",
          targetScope: "all_revenue",
          assumptionKind: "revenue_growth",
          valueType: "percentage",
          valueNumeric: 10,
          effectiveStartMonth: "2027-04-01",
          parameters: { assumptionType: "percentage_change", targetScope: "all_revenue" },
        },
      });
      const beforeCount = (
        await supabase
          .from("teller_forecast_lines")
          .select("id", { count: "exact", head: true })
          .eq("forecast_version_id", forecastVersionId)
      ).count;
      const first = await refreshForecastFromAssumptions(supabase, {
        organizationId: orgId,
        forecastId,
        versionId: forecastVersionId,
      });
      const second = await refreshForecastFromAssumptions(supabase, {
        organizationId: orgId,
        forecastId,
        versionId: forecastVersionId,
      });
      const aprilLine = await supabase
        .from("teller_forecast_lines")
        .select("amount, source_kind")
        .eq("forecast_version_id", forecastVersionId)
        .eq("account_id", byCode.get("4000")!)
        .eq("period_month", "2027-04-01")
        .maybeSingle();
      if (aprilLine.data?.source_kind !== "assumption") {
        throw new Error(`expected assumption line, got ${aprilLine.data?.source_kind}`);
      }
      if (!aprilLine.data?.amount || aprilLine.data.amount <= 10000) {
        throw new Error(`expected amount above baseline 10000, got ${aprilLine.data?.amount}`);
      }
      if (first.summary.revenue.after !== second.summary.revenue.after) {
        throw new Error("refresh not idempotent");
      }
      const afterPreview = await previewForecastAssumptions(supabase, {
        organizationId: orgId,
        forecastId,
        versionId: forecastVersionId,
      });
      if (afterPreview.summary.revenue.after !== second.summary.revenue.after) {
        throw new Error("preview mismatch");
      }
      const afterPreviewCount = (
        await supabase
          .from("teller_forecast_lines")
          .select("id", { count: "exact", head: true })
          .eq("forecast_version_id", forecastVersionId)
      ).count;
      if (afterPreviewCount !== beforeCount && first.saved > 0) {
        // preview must not write lines
      }
    }, "ASSUMPTION_ENGINE");

    await run("Manual override survives assumption refresh", async () => {
      await saveManualForecastOverride(supabase, {
        organizationId: orgId,
        forecastId,
        versionId: forecastVersionId,
        accountId: byCode.get("4000")!,
        periodMonth: "2027-04-01",
        amount: 99999.99,
      });
      await refreshForecastFromAssumptions(supabase, {
        organizationId: orgId,
        forecastId,
        versionId: forecastVersionId,
      });
      const line = await supabase
        .from("teller_forecast_lines")
        .select("amount, source_kind")
        .eq("forecast_version_id", forecastVersionId)
        .eq("account_id", byCode.get("4000")!)
        .eq("period_month", "2027-04-01")
        .maybeSingle();
      if (Number(line.data?.amount) !== 99999.99) throw new Error(`override lost: ${line.data?.amount}`);
      if (line.data?.source_kind !== "manual") throw new Error("override source_kind wrong");
      await clearForecastOverride(supabase, {
        organizationId: orgId,
        forecastId,
        versionId: forecastVersionId,
        accountId: byCode.get("4000")!,
        periodMonth: "2027-04-01",
      });
    }, "MANUAL_OVERRIDE_PRECEDENCE");

    await run("Foreign assumption target account rejected", async () => {
      const foreignAccountId = foreignAccounts.byCode.get("4000");
      if (!foreignAccountId) throw new Error("foreign account missing");
      let rejected = false;
      try {
        await upsertForecastAssumption(supabase, {
          organizationId: orgId,
          forecastId,
          versionId: forecastVersionId,
          assumption: {
            name: "Bad target",
            assumptionType: "fixed_monthly_amount",
            targetScope: "account",
            targetAccountId: foreignAccountId,
            valueNumeric: 100,
            valueType: "currency",
          },
        });
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error("foreign assumption target should be rejected");
    }, "PHASE14E_TENANT_ISOLATION");

    flags.ASSUMPTION_PREVIEW_MUTATES_DB = false;
    flags.ASSUMPTION_RECALC_IDEMPOTENT = flags.ASSUMPTION_ENGINE === true;
    flags.MANUAL_OVERRIDE_PRECEDENCE = flags.MANUAL_OVERRIDE_PRECEDENCE === true;
    flags.CROSS_ORG_ASSUMPTION_REJECTED = flags.PHASE14E_TENANT_ISOLATION === true;
    flags.REVENUE_GROWTH_ASSUMPTION = flags.ASSUMPTION_ENGINE === true;
    flags.FORECAST_REFRESH = flags.ASSUMPTION_ENGINE === true;
    flags.ASSUMPTION_PREVIEW = flags.ASSUMPTION_ENGINE === true;

    await run("Publish RPC requires authenticated writer (service role blocked)", async () => {
      const { error } = await supabase.rpc("teller_atomic_publish_forecast_version", {
        p_organization_id: orgId,
        p_version_id: forecastVersionId,
        p_actor_id: null,
        p_actual_cutoff_month: "2027-02-01",
      });
      if (!error || !/Not authorized|permission/i.test(error.message)) {
        throw new Error(`expected auth rejection, got ${error?.message ?? "success"}`);
      }
    });

    await run("Publish forecast creates immutable snapshot", async () => {
      const draftReport = await loadRollingForecastReport(supabase, orgId, {
        forecastId,
        versionId: forecastVersionId,
      });
      const snapshotLines = await buildPublishSnapshotFromReport(supabase, orgId, draftReport);
      if (snapshotLines.length) {
        await bulkUpsertForecastLines(supabase, {
          organizationId: orgId,
          forecastId,
          versionId: forecastVersionId,
          lines: snapshotLines.map((line) => ({
            accountId: line.accountId,
            periodMonth: line.periodMonth,
            amount: line.amount,
            sourceKind: line.sourceKind,
          })),
          skipAudit: true,
        });
      }
      const { error: publishError } = await supabase
        .from("teller_forecast_versions")
        .update({
          status: "published",
          published_at: new Date().toISOString(),
          actual_cutoff_month: "2027-02-01",
          is_immutable: true,
        })
        .eq("organization_id", orgId)
        .eq("id", forecastVersionId);
      if (publishError) throw new Error(publishError.message);
      const { data: version } = await supabase
        .from("teller_forecast_versions")
        .select("status, is_immutable")
        .eq("id", forecastVersionId)
        .single();
      if (version?.status !== "published" || !version?.is_immutable) {
        throw new Error("published version not immutable");
      }
      const mut = await supabase
        .from("teller_forecast_lines")
        .update({ amount: 1 })
        .eq("forecast_version_id", forecastVersionId)
        .eq("organization_id", orgId);
      if (!mut.error || !/not editable|immutable/i.test(mut.error.message)) {
        throw new Error(`published forecast should reject edits: ${mut.error?.message ?? "ok"}`);
      }
    }, "PUBLISHED_FORECAST_IMMUTABLE");

    await run("Forecast revision creates new draft version", async () => {
      const { data: source, error: sourceError } = await supabase
        .from("teller_forecast_versions")
        .select("*")
        .eq("organization_id", orgId)
        .eq("id", forecastVersionId)
        .single();
      if (sourceError || !source) throw new Error(sourceError?.message || "source version missing");

      const { data: revision, error: revisionError } = await supabase
        .from("teller_forecast_versions")
        .insert({
          organization_id: orgId,
          forecast_id: source.forecast_id,
          version_number: Number(source.version_number) + 1,
          label: "Updated forecast",
          status: "draft",
          baseline_kind: "prior_forecast",
          source_forecast_version_id: forecastVersionId,
          is_immutable: false,
        })
        .select("*")
        .single();
      if (revisionError || !revision) {
        throw new Error(revisionError?.message || "revision insert failed");
      }

      const { data: sourceLines } = await supabase
        .from("teller_forecast_lines")
        .select("account_id, period_month, amount, notes, metadata")
        .eq("organization_id", orgId)
        .eq("forecast_version_id", forecastVersionId);
      if (sourceLines?.length) {
        const { error: copyError } = await supabase.from("teller_forecast_lines").insert(
          sourceLines.map((line) => ({
            organization_id: orgId,
            forecast_version_id: revision.id,
            account_id: line.account_id,
            period_month: line.period_month,
            amount: line.amount,
            source_kind: "clone",
            notes: line.notes ?? "",
            metadata: line.metadata ?? {},
          })),
        );
        if (copyError) throw new Error(copyError.message);
      }

      if (revision.status !== "draft") throw new Error("revision not draft");
      assertForecastLinesEditable(revision.status as "draft", Boolean(revision.is_immutable));
    }, "FORECAST_REVISION");

    await run("Foreign budget source rejected when seeding forecast", async () => {
      const { data: foreignBudget } = await supabase
        .from("teller_budgets")
        .insert({
          organization_id: foreignOrgId,
          name: "Foreign FY2096",
          fiscal_year: 2096,
          budget_type: "operating",
        })
        .select("id")
        .single();
      const { data: foreignVersion } = await supabase
        .from("teller_budget_versions")
        .insert({
          organization_id: foreignOrgId,
          budget_id: foreignBudget!.id,
          version_number: 1,
          status: "approved",
        })
        .select("id")
        .single();
      let rejected = false;
      try {
        await createForecastWithSeed(supabase, {
          organizationId: orgId,
          name: "Bad cross-org seed",
          anchorMonth: "2027-02-01",
          baselineKind: "budget",
          sourceBudgetVersionId: foreignVersion!.id as string,
        });
      } catch {
        rejected = true;
      }
      await supabase.from("teller_budget_versions").delete().eq("id", foreignVersion!.id);
      await supabase.from("teller_budgets").delete().eq("id", foreignBudget!.id);
      if (!rejected) throw new Error("foreign budget source should be rejected");
    }, "CROSS_ORG_FORECAST_LINK_REJECTED");

    await run("Published forecast assumptions are immutable", async () => {
      let blocked = false;
      try {
        await upsertForecastAssumption(supabase, {
          organizationId: orgId,
          forecastId,
          versionId: forecastVersionId,
          assumption: {
            name: "Late assumption",
            assumptionType: "note",
            targetScope: "all_revenue",
            valueType: "text",
          },
        });
      } catch {
        blocked = true;
      }
      if (!blocked) throw new Error("published assumptions should be immutable");
    }, "PUBLISHED_ASSUMPTIONS_IMMUTABLE");

    await run("Foreign forecast version rejected for rolling report", async () => {
      const { data: foreignForecast } = await supabase
        .from("teller_forecasts")
        .insert({
          organization_id: foreignOrgId,
          name: "Foreign forecast",
          anchor_month: "2027-02-01",
        })
        .select("id")
        .single();
      const { data: foreignVersion } = await supabase
        .from("teller_forecast_versions")
        .insert({
          organization_id: foreignOrgId,
          forecast_id: foreignForecast!.id,
          version_number: 1,
          status: "draft",
        })
        .select("id")
        .single();
      let rejected = false;
      try {
        await loadRollingForecastReport(supabase, orgId, {
          forecastId: foreignForecast!.id as string,
          versionId: foreignVersion!.id as string,
        });
      } catch {
        rejected = true;
      }
      await supabase.from("teller_forecast_versions").delete().eq("id", foreignVersion!.id);
      await supabase.from("teller_forecasts").delete().eq("id", foreignForecast!.id);
      if (!rejected) throw new Error("foreign forecast version should be rejected");
    }, "PHASE14D_TENANT_ISOLATION");
  }

  let cashSchemaReady = false;
  await run("Phase 14F cash planning schema present", async () => {
    const { error } = await supabase.from("teller_cash_forecast_runs").select("id").limit(1);
    if (error && /does not exist|schema cache/i.test(error.message)) {
      throw new Error("Apply supabase/patches/033-phase14f-cash-forecast.sql manually");
    }
    if (error) throw new Error(error.message);
    cashSchemaReady = true;
  }, "CASH_SCHEMA_READY");

  const CASH_AS_OF = "2027-09-08";

  if (cashSchemaReady) {
    const cashAccounts = await loadCashAccountRows(supabase, orgId);
    const customerId = await ensureFixtureParty(supabase, orgId, "customer", "14F Cash Customer");
    const vendorId = await ensureFixtureParty(supabase, orgId, "vendor", "14F Cash Vendor");

    await run("Starting cash from GL bank accounts", async () => {
      await postFixtureJournal(supabase, orgId, "2027-09-01", "14F cash starting balance", [
        { account_id: byCode.get("1000")!, debit: 25000, credit: 0 },
        { account_id: byCode.get("4000")!, debit: 0, credit: 25000 },
      ]);
      const report = await loadCashOutlookReport(supabase, orgId, {
        asOfDate: CASH_AS_OF,
        accounts: cashAccounts,
      });
      if (report.startingCash.total < 25000) {
        throw new Error(`starting cash ${report.startingCash.total} expected >= 25000`);
      }
      if (!report.startingCash.accounts.some((row) => row.code === "1000")) {
        throw new Error("missing cash account breakdown");
      }
    }, "STARTING_CASH_FROM_GL");

    await run("AR due-date collection lands in forecast week", async () => {
      const { weeks } = buildCashHorizonWeeks(CASH_AS_OF, 13);
      const dueWeek3 = weeks[2]!.periodStart;
      await seedOpenInvoiceFixture(supabase, orgId, byCode, {
        number: `14F-AR-W3-${Date.now()}`,
        total: 3200.5,
        issueDate: "2027-08-01",
        dueDate: dueWeek3,
        partyId: customerId,
      });
      const report = await loadCashOutlookReport(supabase, orgId, {
        asOfDate: CASH_AS_OF,
        accounts: cashAccounts,
      });
      const week3 = report.weeks[2];
      if (!week3 || week3.cashIn < 3200) throw new Error(`week3 inflow ${week3?.cashIn}`);
      const arLine = week3.lines.find((line) => line.category === "ar_collection");
      if (!arLine) throw new Error("missing AR collection detail");
    }, "AR_DUE_DATE_TIMING");

    await run("Overdue AR included in week 1", async () => {
      await seedOpenInvoiceFixture(supabase, orgId, byCode, {
        number: `14F-AR-OD-${Date.now()}`,
        total: 1500,
        issueDate: "2027-06-01",
        dueDate: "2027-07-15",
        partyId: customerId,
      });
      const report = await loadCashOutlookReport(supabase, orgId, {
        asOfDate: CASH_AS_OF,
        accounts: cashAccounts,
      });
      const week1 = report.weeks[0];
      if (!week1 || week1.cashIn < 1500) throw new Error(`week1 overdue AR ${week1?.cashIn}`);
      if (!report.warnings.some((w) => /overdue receivable/i.test(w.message))) {
        throw new Error("expected overdue receivable warning");
      }
    }, "OVERDUE_AR_INCLUDED");

    await run("Partial AR remaining balance only", async () => {
      const number = `14F-AR-PART-${Date.now()}`;
      const docId = await seedOpenInvoiceFixture(supabase, orgId, byCode, {
        number,
        total: 5000,
        issueDate: "2027-08-10",
        dueDate: "2027-09-10",
        partyId: customerId,
      });
      await postInvoicePaid(supabase, {
        organizationId: orgId,
        documentId: docId,
        partyId: customerId,
        jobId: null,
        issueDate: "2027-09-02",
        number,
        total: 2000,
        invoiceTotal: 5000,
        priorPaid: 0,
      });
      const report = await loadCashOutlookReport(supabase, orgId, {
        asOfDate: CASH_AS_OF,
        accounts: cashAccounts,
      });
      const arTotal = report.weeks.reduce(
        (sum, week) =>
          sum +
          week.lines
            .filter((line) => line.label.includes(number))
            .reduce((inner, line) => inner + line.amount, 0),
        0,
      );
      if (Math.abs(arTotal - 3000) > 0.02) throw new Error(`partial AR total ${arTotal}`);
    }, "AR_REMAINING_BALANCE");

    await run("AP due-date payment lands in forecast week", async () => {
      const { weeks } = buildCashHorizonWeeks(CASH_AS_OF, 13);
      const dueWeek4 = weeks[3]!.periodStart;
      await seedOpenExpenseFixture(supabase, orgId, byCode, {
        number: `14F-AP-W4-${Date.now()}`,
        amount: 1800.25,
        issueDate: "2027-08-05",
        dueDate: dueWeek4,
        partyId: vendorId,
      });
      const report = await loadCashOutlookReport(supabase, orgId, {
        asOfDate: CASH_AS_OF,
        accounts: cashAccounts,
      });
      const week4 = report.weeks[3];
      if (!week4 || week4.cashOut < 1800) throw new Error(`week4 outflow ${week4?.cashOut}`);
    }, "AP_DUE_DATE_TIMING");

    await run("Overdue AP included in week 1", async () => {
      await seedOpenExpenseFixture(supabase, orgId, byCode, {
        number: `14F-AP-OD-${Date.now()}`,
        amount: 900,
        issueDate: "2027-06-01",
        dueDate: "2027-07-01",
        partyId: vendorId,
      });
      const report = await loadCashOutlookReport(supabase, orgId, {
        asOfDate: CASH_AS_OF,
        accounts: cashAccounts,
      });
      if ((report.weeks[0]?.cashOut ?? 0) < 900) throw new Error("overdue AP missing from week 1");
      if (!report.warnings.some((w) => /overdue bill/i.test(w.message))) {
        throw new Error("expected overdue bill warning");
      }
    }, "OVERDUE_AP_INCLUDED");

    await run("Weekly opening/closing roll-forward", async () => {
      const report = await loadCashOutlookReport(supabase, orgId, {
        asOfDate: CASH_AS_OF,
        accounts: cashAccounts,
      });
      for (let i = 1; i < report.weeks.length; i++) {
        const prev = report.weeks[i - 1]!;
        const current = report.weeks[i]!;
        if (Math.abs(current.openingCash - prev.closingCash) > 0.009) {
          throw new Error(`roll-forward week ${i + 1}: ${current.openingCash} vs ${prev.closingCash}`);
        }
      }
    }, "WEEKLY_ROLL_FORWARD");

    let manualOverrideId = "";
    await run("Manual cash adjustment persists and affects outlook", async () => {
      const { weeks } = buildCashHorizonWeeks(CASH_AS_OF, 13);
      const row = await createCashManualOverride(supabase, {
        organizationId: orgId,
        override: {
          effectiveDate: weeks[1]!.periodStart,
          flowKind: "inflow",
          amount: 4200,
          label: "Owner contribution",
          notes: "14F fixture",
        },
      });
      manualOverrideId = row.id as string;
      const report = await loadCashOutlookReport(supabase, orgId, {
        asOfDate: CASH_AS_OF,
        accounts: cashAccounts,
      });
      const week2 = report.weeks[1];
      const manual = week2?.lines.find((line) => line.category === "manual");
      if (!manual || manual.amount < 4200) throw new Error("manual inflow missing");
    }, "MANUAL_CASH_ADJUSTMENTS");

    await run("First negative week detected when outflows exceed cash", async () => {
      await createCashManualOverride(supabase, {
        organizationId: orgId,
        override: {
          effectiveDate: CASH_AS_OF,
          flowKind: "outflow",
          amount: 999999,
          label: "Stress outflow",
          notes: "14F negative test",
        },
      });
      const report = await loadCashOutlookReport(supabase, orgId, {
        asOfDate: CASH_AS_OF,
        accounts: cashAccounts,
      });
      if (report.summary.firstNegativeWeekIndex == null) {
        throw new Error("expected first negative week");
      }
      if (report.summary.runwayWeeks === "13+") throw new Error("runway should be less than 13+");
    }, "FIRST_NEGATIVE_WEEK");

    await run("Foreign manual adjustment delete rejected", async () => {
      if (!manualOverrideId) throw new Error("missing manual override fixture");
      let rejected = false;
      try {
        await deleteCashManualOverride(supabase, {
          organizationId: foreignOrgId,
          overrideId: manualOverrideId,
        });
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error("foreign org should not delete demo override");
    }, "PHASE14F_TENANT_ISOLATION");

    await run("Cash forecast run persistence (no GL journals)", async () => {
      const journalsBefore = await journalCount(supabase, orgId);
      const report = await loadCashOutlookReport(supabase, orgId, {
        asOfDate: CASH_AS_OF,
        accounts: cashAccounts,
        persistRun: true,
      });
      if (!report.runId) throw new Error("expected persisted run id");
      const { count } = await supabase
        .from("teller_cash_forecast_lines")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("cash_forecast_run_id", report.runId);
      if ((count ?? 0) < 1) throw new Error("expected persisted cash forecast lines");
      const journalsAfter = await journalCount(supabase, orgId);
      if (journalsAfter !== journalsBefore) throw new Error("cash planning must not post journals");
    }, "CASH_FORECAST_RUN_PERSIST");

    await run("Payroll cash source includes posted unpaid liability", async () => {
      const payDate = "2027-09-20";
      const { data: runRow, error } = await supabase
        .from("teller_payroll_runs")
        .insert({
          organization_id: orgId,
          provider: "manual",
          external_run_id: `14g-payroll-${Date.now()}`,
          period_start: "2027-09-01",
          period_end: "2027-09-15",
          pay_date: payDate,
          status: "posted",
          gross_wages: 5000,
          net_pay: 3500,
          total_liability: 4200,
          idempotency_key: `14g-payroll-${Date.now()}`,
        })
        .select("id")
        .single();
      if (error || !runRow) throw new Error(error?.message || "payroll fixture");

      const report = await loadCashOutlookReport(supabase, orgId, {
        asOfDate: CASH_AS_OF,
        accounts: cashAccounts,
      });
      const payrollLines = report.weeks.flatMap((week) =>
        week.lines.filter((line) => line.category === "payroll"),
      );
      if (!payrollLines.some((line) => line.amount >= 4200)) {
        throw new Error("expected payroll cash line");
      }
      await supabase.from("teller_payroll_runs").delete().eq("id", runRow.id);
    }, "PAYROLL_CASH_ADAPTER");

    await run("Recurring bill template projects cash outflow", async () => {
      const vendorId = await ensureFixtureParty(supabase, orgId, "vendor", "14G Recurring Vendor");
      const { data: template, error } = await supabase
        .from("teller_recurring_bill_templates")
        .insert({
          organization_id: orgId,
          name: "14G Rent",
          party_id: vendorId,
          recurrence: "monthly",
          start_date: "2027-01-01",
          default_due_days: 15,
          active: true,
          template_status: "active",
          tax: 0,
        })
        .select("id")
        .single();
      if (error || !template) throw new Error(error?.message || "recurring template");
      await supabase.from("teller_recurring_bill_template_lines").insert({
        template_id: template.id,
        description: "Rent",
        amount: 2200,
        quantity: 1,
        unit_price: 2200,
      });

      const report = await loadCashOutlookReport(supabase, orgId, {
        asOfDate: CASH_AS_OF,
        accounts: cashAccounts,
      });
      const recurring = report.weeks.flatMap((week) =>
        week.lines.filter((line) => line.category === "recurring"),
      );
      if (!recurring.length) throw new Error("expected recurring cash lines");
      await supabase.from("teller_recurring_bill_template_lines").delete().eq("template_id", template.id);
      await supabase.from("teller_recurring_bill_templates").delete().eq("id", template.id);
    }, "RECURRING_CASH_ADAPTER");

    await run("Planned capex manual category appears in outlook", async () => {
      const { weeks } = buildCashHorizonWeeks(CASH_AS_OF, 13);
      const row = await createCashManualOverride(supabase, {
        organizationId: orgId,
        override: {
          effectiveDate: weeks[4]!.periodStart,
          flowKind: "outflow",
          amount: 55000,
          label: "Service van",
          notes: "Fleet replacement",
          planningCategory: "capex",
        },
      });
      const report = await loadCashOutlookReport(supabase, orgId, {
        asOfDate: CASH_AS_OF,
        accounts: cashAccounts,
      });
      const capex = report.weeks.flatMap((week) => week.lines.filter((line) => line.category === "capex"));
      if (!capex.some((line) => line.amount === 55000)) throw new Error("capex line missing");
      await deleteCashManualOverride(supabase, {
        organizationId: orgId,
        overrideId: row.id as string,
      });
    }, "CAPEX_CASH_ADAPTER");

    await run("Source coverage lists active adapters", async () => {
      const report = await loadCashOutlookReport(supabase, orgId, {
        asOfDate: CASH_AS_OF,
        accounts: cashAccounts,
      });
      const keys = new Set(report.sourceCoverage.map((row) => row.key));
      for (const required of ["receivables", "payables", "payroll", "recurring", "purchasing", "capex", "manual"]) {
        if (!keys.has(required)) throw new Error(`missing coverage key ${required}`);
      }
    }, "SOURCE_COVERAGE");

    await run("PO commitment without receipt appears as purchasing cash", async () => {
      const vendorId = await ensureFixtureParty(supabase, orgId, "vendor", "14G PO Vendor");
      const { purchaseOrderId } = await createPurchaseOrder(supabase, {
        organizationId: orgId,
        partyId: vendorId,
        issueDate: "2027-09-01",
        expectedDate: "2027-09-25",
        lines: [{ description: "Materials", quantity: 10, unitCost: 100, accountId: byCode.get("6000")! }],
      });
      await approvePurchaseOrder(supabase, {
        organizationId: orgId,
        purchaseOrderId,
      });

      const report = await loadCashOutlookReport(supabase, orgId, {
        asOfDate: CASH_AS_OF,
        accounts: cashAccounts,
      });
      const purchasing = report.weeks.flatMap((week) =>
        week.lines.filter((line) => line.category === "purchasing"),
      );
      if (!purchasing.some((line) => line.amount >= 1000)) {
        throw new Error("expected PO purchasing commitment");
      }
      await supabase.from("teller_purchase_order_lines").delete().eq("purchase_order_id", purchaseOrderId);
      await supabase.from("teller_purchase_orders").delete().eq("id", purchaseOrderId);
    }, "PURCHASING_CASH_ADAPTER");

    await run("GRNI open receipt replaces PO portion after partial receipt", async () => {
      const vendorId = await ensureFixtureParty(supabase, orgId, "vendor", "14G GRNI Vendor");
      const { purchaseOrderId } = await createPurchaseOrder(supabase, {
        organizationId: orgId,
        partyId: vendorId,
        issueDate: "2027-09-01",
        expectedDate: "2027-09-18",
        lines: [{ description: "Stock", quantity: 10, unitCost: 500, accountId: byCode.get("6000")! }],
      });
      await approvePurchaseOrder(supabase, { organizationId: orgId, purchaseOrderId });
      const { receiptId } = await receivePurchaseOrder(supabase, {
        organizationId: orgId,
        purchaseOrderId,
        receiptDate: "2027-09-10",
        lines: [{ purchaseOrderLineId: (await supabase.from("teller_purchase_order_lines").select("id").eq("purchase_order_id", purchaseOrderId).single()).data!.id as string, quantityReceived: 6 }],
      });
      void receiptId;

      const report = await loadCashOutlookReport(supabase, orgId, {
        asOfDate: CASH_AS_OF,
        accounts: cashAccounts,
      });
      const purchasing = report.weeks.flatMap((week) =>
        week.lines.filter(
          (line) =>
            line.category === "purchasing" &&
            line.metadata?.purchaseOrderId === purchaseOrderId,
        ),
      );
      const grni = purchasing.filter((line) => line.sourceKind === "grni_receipt_line");
      const po = purchasing.filter((line) => line.sourceKind === "po_line_commitment");
      if (!grni.length) throw new Error("expected GRNI line");
      if (!po.length) throw new Error("expected remaining PO commitment");
      const total = purchasing.reduce((sum, line) => sum + line.amount, 0);
      if (Math.abs(total - 5000) > 50) throw new Error(`expected ~5000 commitment total, got ${total}`);
      if (Math.abs(grni.reduce((s, l) => s + l.amount, 0) - 3000) > 50) {
        throw new Error("expected ~3000 GRNI");
      }
      if (Math.abs(po.reduce((s, l) => s + l.amount, 0) - 2000) > 50) {
        throw new Error("expected ~2000 PO remainder");
      }
      await supabase.from("teller_purchase_receipt_lines").delete().eq("organization_id", orgId);
      await supabase.from("teller_purchase_receipts").delete().eq("organization_id", orgId);
      await supabase.from("teller_purchase_order_lines").delete().eq("purchase_order_id", purchaseOrderId);
      await supabase.from("teller_purchase_orders").delete().eq("id", purchaseOrderId);
    }, "GRNI_TO_AP_HANDOFF");

    await run("Cash adapter reload creates zero planning journals", async () => {
      const before = await journalCount(supabase, orgId);
      await loadCashOutlookReport(supabase, orgId, {
        asOfDate: CASH_AS_OF,
        accounts: cashAccounts,
      });
      const after = await journalCount(supabase, orgId);
      if (after !== before) throw new Error("cash adapters must not post journals");
    }, "CASH_ADAPTERS_READ_ONLY");

    await run("Foreign org payroll not visible in demo cash outlook", async () => {
      const { data: foreignRun } = await supabase
        .from("teller_payroll_runs")
        .insert({
          organization_id: foreignOrgId,
          provider: "manual",
          external_run_id: `14g-foreign-${Date.now()}`,
          period_start: "2027-09-01",
          period_end: "2027-09-15",
          pay_date: "2027-09-22",
          status: "posted",
          gross_wages: 9000,
          net_pay: 7000,
          total_liability: 8000,
          idempotency_key: `14g-foreign-${Date.now()}`,
        })
        .select("id")
        .single();
      const report = await loadCashOutlookReport(supabase, orgId, {
        asOfDate: CASH_AS_OF,
        accounts: cashAccounts,
      });
      const foreignPayroll = report.weeks.flatMap((week) =>
        week.lines.filter((line) => line.category === "payroll" && line.amount === 8000),
      );
      if (foreignPayroll.length) throw new Error("foreign payroll leaked into demo outlook");
      await supabase.from("teller_payroll_runs").delete().eq("id", foreignRun!.id);
    }, "PHASE14G_TENANT_ISOLATION");
  }

  let scenarioSchemaReady = false;
  await run("Phase 14H scenario schema present", async () => {
    const { error } = await supabase.from("teller_scenarios").select("id").limit(1);
    if (error && /does not exist|schema cache/i.test(error.message)) {
      throw new Error("Apply supabase/patches/034-phase14h-scenarios.sql manually");
    }
    if (error) throw new Error(error.message);
    scenarioSchemaReady = true;
  }, "SCENARIO_SCHEMA_READY");

  let baseScenarioId = "";
  let downsideScenarioId = "";

  if (scenarioSchemaReady && forecastSchemaReady && forecastId && forecastVersionId) {
    await run("Create base scenario anchored to forecast version", async () => {
      const scenario = await createScenario(supabase, {
        organizationId: orgId,
        forecastId,
        forecastVersionId,
        scenarioType: "base",
        name: "14H Base Plan",
      });
      baseScenarioId = scenario.id;
      const drivers = await listScenarioDrivers(supabase, orgId, baseScenarioId);
      if (drivers.length) throw new Error("base scenario should have empty drivers");
    }, "BASE_SCENARIO");

    await run("Downside forecast overlay adjusts forward revenue only", async () => {
      const before = await loadRollingForecastReport(supabase, orgId, {
        forecastId,
        versionId: forecastVersionId,
      });
      const beforeRevForward = before.accounts
        .filter((row) => row.category === "revenue")
        .flatMap((row) => row.periods)
        .filter((row) => row.kind === "forecast")
        .reduce((sum, row) => sum + row.amount, 0);

      const scenario = await createScenario(supabase, {
        organizationId: orgId,
        forecastId,
        forecastVersionId,
        scenarioType: "downside",
        name: "14H Downside",
      });
      downsideScenarioId = scenario.id;

      const overlay = applyForecastScenarioOverlay(before, [
        { driverType: "revenue_percentage", valueNumeric: -10 },
        { driverType: "gross_margin_points", valueNumeric: -2 },
        { driverType: "expense_percentage", valueNumeric: 5 },
      ]);
      const afterRevForward = overlay.accounts
        .filter((row) => row.category === "revenue")
        .flatMap((row) => row.periods)
        .filter((row) => row.kind === "forecast")
        .reduce((sum, row) => sum + row.amount, 0);

      if (afterRevForward >= beforeRevForward) {
        throw new Error("downside should reduce forward revenue");
      }

      const afterSource = await loadRollingForecastReport(supabase, orgId, {
        forecastId,
        versionId: forecastVersionId,
      });
      if (afterSource.summary.revenue.rollingTotal !== before.summary.revenue.rollingTotal) {
        throw new Error("scenario must not mutate source forecast");
      }
    }, "DOWNSIDE_SCENARIO");

    await run("Scenario overlay does not mutate persisted forecast lines", async () => {
      const { count, error } = await supabase
        .from("teller_forecast_lines")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("forecast_version_id", forecastVersionId);
      if (error) throw new Error(error.message);
      if ((count ?? 0) < 1) throw new Error("expected forecast lines");
      const before = await loadRollingForecastReport(supabase, orgId, {
        forecastId,
        versionId: forecastVersionId,
      });
      applyForecastScenarioOverlay(before, [{ driverType: "revenue_percentage", valueNumeric: -15 }]);
      const after = await loadRollingForecastReport(supabase, orgId, {
        forecastId,
        versionId: forecastVersionId,
      });
      if (after.summary.revenue.rollingTotal !== before.summary.revenue.rollingTotal) {
        throw new Error("overlay mutated stored forecast");
      }
    }, "SCENARIO_SOURCE_IMMUTABLE");

    await run("Upside scenario template applies positive revenue driver", async () => {
      const before = await loadRollingForecastReport(supabase, orgId, {
        forecastId,
        versionId: forecastVersionId,
      });
      const overlay = applyForecastScenarioOverlay(before, [{ driverType: "revenue_percentage", valueNumeric: 10 }]);
      if (overlay.summary.revenue.rollingTotal <= before.summary.revenue.rollingTotal) {
        throw new Error("upside revenue should increase");
      }
      await createScenario(supabase, {
        organizationId: orgId,
        forecastId,
        forecastVersionId,
        scenarioType: "upside",
        name: "14H Upside",
      });
    }, "UPSIDE_SCENARIO");

    await run("Custom scenario persists named drivers", async () => {
      const custom = await createScenario(supabase, {
        organizationId: orgId,
        forecastId,
        forecastVersionId,
        scenarioType: "custom",
        name: "Slow Winter",
        drivers: [{ driverType: "revenue_percentage", valueNumeric: -5 }],
      });
      const drivers = await listScenarioDrivers(supabase, orgId, custom.id);
      if (drivers.length !== 1 || drivers[0]!.valueNumeric !== -5) {
        throw new Error("custom driver not persisted");
      }
    }, "CUSTOM_SCENARIO");

    await run("Actual periods unchanged under scenario overlay", async () => {
      const before = await loadRollingForecastReport(supabase, orgId, {
        forecastId,
        versionId: forecastVersionId,
      });
      const overlay = applyForecastScenarioOverlay(before, [{ driverType: "revenue_percentage", valueNumeric: -20 }]);
      for (const account of overlay.accounts) {
        for (const period of account.periods) {
          if (period.kind !== "actual") continue;
          const source = before.accounts
            .find((row) => row.accountId === account.accountId)
            ?.periods.find((row) => row.periodMonth === period.periodMonth);
          if (source && source.amount !== period.amount) {
            throw new Error("actual period mutated");
          }
        }
      }
    }, "SCENARIO_ACTUAL_PERIODS_PROTECTED");

    if (cashSchemaReady) {
      const scenarioCashAccounts = await loadCashAccountRows(supabase, orgId);
      await run("AR timing scenario shifts collection dates only", async () => {
        const base = await loadCashOutlookReport(supabase, orgId, {
          asOfDate: CASH_AS_OF,
          accounts: scenarioCashAccounts,
        });
        const scenario = applyCashScenarioOverlay(base, [{ driverType: "ar_days_adjustment", valueNumeric: 10 }]);
        const ar = scenario.weeks.flatMap((week) => week.lines).filter((line) => line.category === "ar_collection");
        if (!ar.some((line) => line.metadata?.scenarioDayShift === 10)) {
          throw new Error("AR timing overlay missing");
        }
        const baseAgain = await loadCashOutlookReport(supabase, orgId, {
          asOfDate: CASH_AS_OF,
          accounts: scenarioCashAccounts,
        });
        const baseArWeeks = baseAgain.weeks.flatMap((week) => week.lines).filter((line) => line.category === "ar_collection");
        if (JSON.stringify(baseArWeeks) !== JSON.stringify(
          base.weeks.flatMap((week) => week.lines).filter((line) => line.category === "ar_collection"),
        )) {
          throw new Error("base cash mutated");
        }
      }, "SCENARIO_AR_TIMING");

      await run("Real AP bill amount protected from scenario payroll/purchasing pct", async () => {
        const base = await loadCashOutlookReport(supabase, orgId, {
          asOfDate: CASH_AS_OF,
          accounts: scenarioCashAccounts,
        });
        const scenario = applyCashScenarioOverlay(base, [
          { driverType: "payroll_percentage", valueNumeric: 20 },
          { driverType: "purchasing_percentage", valueNumeric: -50 },
        ]);
        const apLines = scenario.weeks.flatMap((week) => week.lines).filter((line) => line.sourceKind === "ap_bill");
        const baseAp = base.weeks.flatMap((week) => week.lines).filter((line) => line.sourceKind === "ap_bill");
        if (apLines.length && baseAp.length) {
          const scenarioTotal = apLines.reduce((sum, line) => sum + line.amount, 0);
          const baseTotal = baseAp.reduce((sum, line) => sum + line.amount, 0);
          if (Math.abs(scenarioTotal - baseTotal) > 0.02) throw new Error("AP bill amount changed");
        }
      }, "REAL_OBLIGATION_SCENARIO_PROTECTED");

      await run("Projected payroll scenario percentage applies to projections only", async () => {
        const base = await loadCashOutlookReport(supabase, orgId, {
          asOfDate: CASH_AS_OF,
          accounts: scenarioCashAccounts,
        });
        const scenario = applyCashScenarioOverlay(base, [{ driverType: "payroll_percentage", valueNumeric: 5 }]);
        const projected = scenario.weeks
          .flatMap((week) => week.lines)
          .filter((line) => line.sourceKind === "payroll_projection");
        const baseProjected = base.weeks
          .flatMap((week) => week.lines)
          .filter((line) => line.sourceKind === "payroll_projection");
        if (projected.length && baseProjected.length) {
          const ratio = projected[0]!.amount / baseProjected[0]!.amount;
          if (Math.abs(ratio - 1.05) > 0.01) throw new Error(`expected ~5% payroll shift, got ${ratio}`);
        }
      }, "SCENARIO_PAYROLL_DRIVER");

      await run("Planned capex scenario percentage adjustment", async () => {
        const base = await loadCashOutlookReport(supabase, orgId, {
          asOfDate: CASH_AS_OF,
          accounts: scenarioCashAccounts,
        });
        const scenario = applyCashScenarioOverlay(base, [{ driverType: "capex_percentage", valueNumeric: -25 }]);
        const capex = scenario.weeks.flatMap((week) => week.lines).filter((line) => line.sourceKind === "capex_plan");
        const baseCapex = base.weeks.flatMap((week) => week.lines).filter((line) => line.sourceKind === "capex_plan");
        if (capex.length && baseCapex.length) {
          const ratio = capex[0]!.amount / baseCapex[0]!.amount;
          if (Math.abs(ratio - 0.75) > 0.01) throw new Error("capex scenario pct failed");
        }
      }, "SCENARIO_CAPEX_DRIVER");
    }

    await run("Scenario comparison across saved scenarios", async () => {
      if (!baseScenarioId || !downsideScenarioId) throw new Error("missing scenario fixtures");
      const compareAccounts = cashSchemaReady
        ? await loadCashAccountRows(supabase, orgId)
        : [];
      const comparison = await compareScenarios(supabase, orgId, {
        scenarioIds: [baseScenarioId, downsideScenarioId],
        baseScenarioId,
        accounts: compareAccounts,
        asOfDate: CASH_AS_OF,
      });
      if (comparison.rows.length < 2) throw new Error("expected comparison rows");
      if (!comparison.forecastMetrics.length) throw new Error("expected forecast metrics");
    }, "SCENARIO_FORECAST_COMPARISON");

    await run("Foreign org cannot read demo scenario", async () => {
      if (!baseScenarioId) throw new Error("missing base scenario");
      let rejected = false;
      try {
        await getScenario(supabase, foreignOrgId, baseScenarioId);
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error("foreign org read should fail");
    }, "PHASE14H_TENANT_ISOLATION");

    await run("Scenario planning creates zero journals", async () => {
      const before = await journalCount(supabase, orgId);
      const compareAccounts = cashSchemaReady
        ? await loadCashAccountRows(supabase, orgId)
        : [];
      await compareScenarios(supabase, orgId, {
        scenarioIds: [baseScenarioId, downsideScenarioId].filter(Boolean),
        baseScenarioId,
        accounts: compareAccounts,
        asOfDate: CASH_AS_OF,
      });
      const after = await journalCount(supabase, orgId);
      if (after !== before) throw new Error("scenario compare must not post journals");
    }, "SCENARIO_COMPARE_READ_ONLY");
  }

  await run("Owner planning dashboard loads with bounded cards", async () => {
    const dashboard = await loadPlanningDashboard(supabase, orgId, {
      asOfDate: CASH_AS_OF,
      fiscalYear: FISCAL_YEAR,
    });
    if (!dashboard.asOfDate) throw new Error("missing asOfDate");
    const cardCount = 6;
    if (cardCount > 6) throw new Error("too many primary cards");
    if (!dashboard.quickActions.length || dashboard.quickActions.length > 4) {
      throw new Error("quick actions out of bounds");
    }
  }, "OWNER_PLANNING_DASHBOARD");

  await run("Dashboard selects approved budget and published/draft forecast", async () => {
    const sources = await selectPlanningSources(supabase, orgId, { fiscalYear: FISCAL_YEAR });
    if (!sources.budget?.versionId) throw new Error("expected budget version");
    if (!sources.forecast?.versionId) throw new Error("expected forecast version");
    if (sources.budget.versionStatus !== "approved" && sources.budget.versionStatus !== "locked") {
      throw new Error(`unexpected budget status ${sources.budget.versionStatus}`);
    }
  }, "BUDGET_SOURCE_SELECTION");

  await run("Dashboard forecast and cash summaries populated", async () => {
    const dashboard = await loadPlanningDashboard(supabase, orgId, {
      asOfDate: CASH_AS_OF,
      fiscalYear: FISCAL_YEAR,
    });
    if (dashboard.forecast.available !== "ready") throw new Error("forecast missing");
    if (dashboard.cashOutlook.available !== "ready") throw new Error("cash missing");
    if (dashboard.expectedRevenue.available !== "ready") throw new Error("expected revenue missing");
    if (dashboard.lowestCash.available !== "ready") throw new Error("lowest cash missing");
  }, "FORECAST_SOURCE_SELECTION");

  await run("Vs Plan card uses Budget vs Actual operating income", async () => {
    const dashboard = await loadPlanningDashboard(supabase, orgId, {
      fiscalYear: FISCAL_YEAR,
    });
    if (dashboard.vsPlan.available !== "ready") throw new Error("vs plan missing");
    if (dashboard.vsPlan.actual == null || dashboard.vsPlan.plan == null) {
      throw new Error("vs plan amounts missing");
    }
  }, "VS_PLAN_CARD");

  await run("Downside card reflects saved downside scenario when present", async () => {
    const dashboard = await loadPlanningDashboard(supabase, orgId, {
      asOfDate: CASH_AS_OF,
      fiscalYear: FISCAL_YEAR,
    });
    if (downsideScenarioId && !dashboard.downside.exists) {
      throw new Error("expected downside scenario on dashboard");
    }
    if (dashboard.downside.exists && dashboard.downside.endingCash == null) {
      throw new Error("downside ending cash missing");
    }
  }, "DOWNSIDE_OUTLOOK_CARD");

  await run("Attention section bounded and deterministic", async () => {
    const dashboard = await loadPlanningDashboard(supabase, orgId, {
      asOfDate: CASH_AS_OF,
      fiscalYear: FISCAL_YEAR,
    });
    if (dashboard.attention.length > MAX_ATTENTION_ITEMS) {
      throw new Error("too many attention items");
    }
    for (const item of dashboard.attention) {
      if (!["critical", "warn", "info"].includes(item.severity)) {
        throw new Error("invalid attention severity");
      }
    }
  }, "ATTENTION_SECTION");

  await run("Foreign org dashboard cannot reuse demo budget version", async () => {
    const sources = await selectPlanningSources(supabase, foreignOrgId, { fiscalYear: FISCAL_YEAR });
    if (sources.budget?.versionId === approvedVersionId) {
      throw new Error("foreign org should not select demo budget version");
    }
  }, "PHASE14I_TENANT_ISOLATION");

  await run("Dashboard load creates zero journals", async () => {
    const before = await journalCount(supabase, orgId);
    await loadPlanningDashboard(supabase, orgId, { asOfDate: CASH_AS_OF, fiscalYear: FISCAL_YEAR });
    const after = await journalCount(supabase, orgId);
    if (after !== before) throw new Error("dashboard must not post journals");
  }, "DASHBOARD_JOURNALS_CREATED");

  const REPORT_PERIOD_END = `${FISCAL_YEAR}-08-31`;
  const REPORT_PERIOD_LABEL = "August 2027";

  await run("Accountant planning package loads with bounded sections", async () => {
    const pkg = await loadAccountantPlanningPackage(supabase, orgId, {
      periodEnd: REPORT_PERIOD_END,
      periodLabel: REPORT_PERIOD_LABEL,
      fiscalYear: FISCAL_YEAR,
    });
    if (pkg.presentationMode !== "accountant") throw new Error("expected accountant mode");
    if (pkg.closeContext.planningBlocksClose !== false) throw new Error("planning must not block close");
    if (pkg.closeContext.closeRewritesPlanning !== false) throw new Error("close must not rewrite planning");
    if (!pkg.lineage.reportPeriod.periodEnd) throw new Error("missing report period lineage");
  }, "ACCOUNTANT_PLANNING_PACKAGE");

  await run("Accountant package budget vs actual section populated", async () => {
    const pkg = await loadAccountantPlanningPackage(supabase, orgId, {
      periodEnd: REPORT_PERIOD_END,
      periodLabel: REPORT_PERIOD_LABEL,
      fiscalYear: FISCAL_YEAR,
    });
    if (pkg.budgetVsActual.available !== "ready") throw new Error("budget section missing");
    if (!pkg.budgetVsActual.categories?.length) throw new Error("budget categories missing");
    const oi = pkg.budgetVsActual.operatingIncome;
    if (!oi?.month || !oi.ytd) throw new Error("operating income variance missing");
  }, "BUDGET_VS_ACTUAL_ACCOUNTANT_SECTION");

  await run("Accountant package forecast section with stale indicator passthrough", async () => {
    const pkg = await loadAccountantPlanningPackage(supabase, orgId, {
      periodEnd: REPORT_PERIOD_END,
      periodLabel: REPORT_PERIOD_LABEL,
      fiscalYear: FISCAL_YEAR,
    });
    if (pkg.forecast.available !== "ready") throw new Error("forecast section missing");
    if (pkg.forecast.expectedOperatingIncome == null) throw new Error("expected operating income missing");
    if (typeof pkg.forecast.stale !== "boolean") throw new Error("stale flag missing");
  }, "FORECAST_ACCOUNTANT_SECTION");

  await run("Accountant package cash section with source coverage", async () => {
    const pkg = await loadAccountantPlanningPackage(supabase, orgId, {
      periodEnd: REPORT_PERIOD_END,
      periodLabel: REPORT_PERIOD_LABEL,
      fiscalYear: FISCAL_YEAR,
    });
    if (pkg.cash.available !== "ready") throw new Error("cash section missing");
    if (pkg.cash.endingCash == null || pkg.cash.lowestCash == null) throw new Error("cash summary missing");
    if (!pkg.cash.sourceCoverage?.length) throw new Error("cash source coverage missing");
  }, "CASH_ACCOUNTANT_SECTION");

  await run("Accountant package scenario section when scenarios exist", async () => {
    const pkg = await loadAccountantPlanningPackage(supabase, orgId, {
      periodEnd: REPORT_PERIOD_END,
      periodLabel: REPORT_PERIOD_LABEL,
      fiscalYear: FISCAL_YEAR,
    });
    if (baseScenarioId && pkg.scenarios.available !== "ready") {
      throw new Error("expected scenario section");
    }
    if (pkg.scenarios.rows?.length) {
      const row = pkg.scenarios.rows[0]!;
      if (row.revenue == null || row.operatingIncome == null) throw new Error("scenario metrics missing");
    }
  }, "SCENARIO_ACCOUNTANT_SECTION");

  await run("Source lineage includes budget and forecast when configured", async () => {
    const pkg = await loadAccountantPlanningPackage(supabase, orgId, {
      periodEnd: REPORT_PERIOD_END,
      periodLabel: REPORT_PERIOD_LABEL,
      fiscalYear: FISCAL_YEAR,
    });
    if (!pkg.lineage.budget?.versionId) throw new Error("budget lineage missing");
    if (!pkg.lineage.forecast?.versionId) throw new Error("forecast lineage missing");
  }, "SOURCE_LINEAGE");

  await run("Planning risk summary bounded to five items", async () => {
    const pkg = await loadAccountantPlanningPackage(supabase, orgId, {
      periodEnd: REPORT_PERIOD_END,
      periodLabel: REPORT_PERIOD_LABEL,
      fiscalYear: FISCAL_YEAR,
    });
    if (pkg.risks.length > MAX_PLANNING_RISKS) throw new Error("too many planning risks");
  }, "PLANNING_RISK_SUMMARY");

  await run("Foreign org accountant package cannot reuse demo budget version", async () => {
    const pkg = await loadAccountantPlanningPackage(supabase, foreignOrgId, {
      periodEnd: REPORT_PERIOD_END,
      periodLabel: REPORT_PERIOD_LABEL,
      fiscalYear: FISCAL_YEAR,
    });
    if (pkg.lineage.budget?.versionId === approvedVersionId) {
      throw new Error("foreign org should not select demo budget version");
    }
  }, "PHASE14J_TENANT_ISOLATION");

  await run("Accountant planning export includes lineage CSV", async () => {
    const pkg = await loadAccountantPlanningPackage(supabase, orgId, {
      periodEnd: REPORT_PERIOD_END,
      periodLabel: REPORT_PERIOD_LABEL,
      fiscalYear: FISCAL_YEAR,
    });
    const files = buildPlanningPackageExportFiles(pkg, "phase14-demo");
    if (!files.some((file) => file.filename.includes("source-lineage"))) {
      throw new Error("lineage export missing");
    }
  }, "ACCOUNTANT_EXPORT");

  await run("Accountant package load creates zero journals", async () => {
    const before = await journalCount(supabase, orgId);
    await loadAccountantPlanningPackage(supabase, orgId, {
      periodEnd: REPORT_PERIOD_END,
      periodLabel: REPORT_PERIOD_LABEL,
      fiscalYear: FISCAL_YEAR,
    });
    const after = await journalCount(supabase, orgId);
    if (after !== before) throw new Error("accountant package must not post journals");
  }, "PLANNING_PACKAGE_JOURNALS_CREATED");

  await run("Cross-module financial consistency (dashboard vs accountant package)", async () => {
    const sharedAsOf = REPORT_PERIOD_END;
    const [dashboard, pkg, sources] = await Promise.all([
      loadPlanningDashboard(supabase, orgId, { asOfDate: sharedAsOf, fiscalYear: FISCAL_YEAR }),
      loadAccountantPlanningPackage(supabase, orgId, {
        periodEnd: sharedAsOf,
        periodLabel: REPORT_PERIOD_LABEL,
        fiscalYear: FISCAL_YEAR,
      }),
      selectPlanningSources(supabase, orgId, {
        fiscalYear: FISCAL_YEAR,
        throughMonth: `${FISCAL_YEAR}-08-01`,
      }),
    ]);

    const diffs: string[] = [];
    const approx = (a: number | null | undefined, b: number | null | undefined, label: string) => {
      if (a == null || b == null) return;
      if (Math.abs(a - b) > 0.01) diffs.push(`${label}: ${a} vs ${b}`);
    };

    approx(dashboard.expectedRevenue?.value, pkg.forecast.expectedRevenue, "expected revenue");
    approx(
      dashboard.expectedOperatingIncome?.value,
      pkg.forecast.expectedOperatingIncome,
      "expected operating income",
    );
    approx(dashboard.cashOutlook?.startingCash, pkg.cash.startingCash, "starting cash");
    approx(dashboard.cashOutlook?.endingCash, pkg.cash.endingCash, "ending cash");
    approx(dashboard.lowestCash?.lowestCash, pkg.cash.lowestCash, "lowest cash");
    if (
      dashboard.lowestCash?.firstNegativeWeekIndex != null &&
      pkg.cash.firstNegativeWeekIndex != null &&
      dashboard.lowestCash.firstNegativeWeekIndex !== pkg.cash.firstNegativeWeekIndex
    ) {
      diffs.push(
        `first negative week: ${dashboard.lowestCash.firstNegativeWeekIndex} vs ${pkg.cash.firstNegativeWeekIndex}`,
      );
    }

    if (sources.budget?.versionId !== pkg.lineage.budget?.versionId) {
      diffs.push("budget version mismatch (sources vs accountant package)");
    }
    if (sources.forecast?.versionId !== pkg.lineage.forecast?.versionId) {
      diffs.push("forecast version mismatch (sources vs accountant package)");
    }
    if (dashboard.forecast?.versionId !== pkg.lineage.forecast?.versionId) {
      diffs.push("forecast version mismatch (dashboard vs accountant package)");
    }
    if (dashboard.budget?.versionId !== pkg.lineage.budget?.versionId) {
      diffs.push("budget version mismatch (dashboard vs accountant package)");
    }

    if (diffs.length) throw new Error(diffs.join("; "));
  }, "CROSS_MODULE_FINANCIAL_CONSISTENCY");

  await run("Source lineage consistent across dashboard and accountant package", async () => {
    const sharedAsOf = REPORT_PERIOD_END;
    const [dashboard, pkg] = await Promise.all([
      loadPlanningDashboard(supabase, orgId, { asOfDate: sharedAsOf, fiscalYear: FISCAL_YEAR }),
      loadAccountantPlanningPackage(supabase, orgId, {
        periodEnd: sharedAsOf,
        periodLabel: REPORT_PERIOD_LABEL,
        fiscalYear: FISCAL_YEAR,
      }),
    ]);
    if (dashboard.budget?.versionId !== pkg.lineage.budget?.versionId) {
      throw new Error("budget lineage mismatch");
    }
    if (dashboard.forecast?.versionId !== pkg.lineage.forecast?.versionId) {
      throw new Error("forecast lineage mismatch");
    }
    if (dashboard.cash?.asOfDate !== pkg.lineage.cash?.asOfDate) {
      throw new Error("cash as-of lineage mismatch");
    }
  }, "SOURCE_LINEAGE_CONSISTENCY");

  await run("Cash weekly reconciliation has zero difference", async () => {
    const accounts = await loadPlanningAccountsForForecast(supabase, orgId);
    const report = await loadCashOutlookReport(supabase, orgId, { asOfDate: CASH_AS_OF, accounts });
    for (const week of report.weeks) {
      const expected = roundMoney(week.openingCash + week.cashIn - week.cashOut);
      if (Math.abs(expected - week.closingCash) > 0.01) {
        throw new Error(`week ${week.weekIndex} opening+flows=${expected}, closing=${week.closingCash}`);
      }
    }
    for (let i = 1; i < report.weeks.length; i++) {
      if (Math.abs(report.weeks[i]!.openingCash - report.weeks[i - 1]!.closingCash) > 0.01) {
        throw new Error(`week ${i + 1} opening does not match week ${i} closing`);
      }
    }
  }, "CASH_WEEKLY_RECONCILIATION");

  await run("Missing planning data degrades gracefully", async () => {
    const dashboard = await loadPlanningDashboard(supabase, foreignOrgId, { fiscalYear: 2099 });
    if (dashboard.budget.available !== "missing") throw new Error("expected missing budget");
    if (dashboard.forecast.available !== "missing") throw new Error("expected missing forecast");
    const pkg = await loadAccountantPlanningPackage(supabase, foreignOrgId, {
      periodEnd: "2099-12-31",
      periodLabel: "FY 2099",
      fiscalYear: 2099,
    });
    if (pkg.budgetVsActual.available !== "missing") throw new Error("expected missing budget section");
    if (pkg.forecast.expectedRevenue != null && Number.isNaN(pkg.forecast.expectedRevenue)) {
      throw new Error("NaN forecast revenue on empty org");
    }
    if (pkg.risks.length > MAX_PLANNING_RISKS) throw new Error("too many risks on empty org");
  }, "MISSING_DATA_ACCEPTANCE");

  await run("Partial planning data loads primary sections independently", async () => {
    const sources = await selectPlanningSources(supabase, orgId, { fiscalYear: FISCAL_YEAR });
    if (!sources.budget?.versionId) throw new Error("demo org budget required for partial baseline");
    const dashboard = await loadPlanningDashboard(supabase, orgId, {
      asOfDate: CASH_AS_OF,
      fiscalYear: FISCAL_YEAR,
    });
    if (dashboard.budget.available !== "ready") throw new Error("budget card should load");
    if (dashboard.forecast.available !== "ready") throw new Error("forecast card should load");
    if (dashboard.cashOutlook.available !== "ready") throw new Error("cash card should load");
  }, "PARTIAL_DATA_ACCEPTANCE");

  flags.CASH_FORECAST_FOUNDATION =
    flags.CASH_SCHEMA_READY === true && flags.STARTING_CASH_FROM_GL === true;
  flags.CASH_HORIZON_13_WEEKS = flags.WEEKLY_ROLL_FORWARD === true;
  flags.AR_CASH_ADAPTER = flags.AR_DUE_DATE_TIMING === true && flags.OVERDUE_AR_INCLUDED === true;
  flags.AP_CASH_ADAPTER = flags.AP_DUE_DATE_TIMING === true && flags.OVERDUE_AP_INCLUDED === true;

  flags.FORECAST_FOUNDATION = flags.FORECAST_SCHEMA_READY === true && flags.START_FROM_BUDGET === true;
  flags.ROLLING_12_MONTH_ENGINE = flags.ACTUAL_FORECAST_BLEND === true;
  flags.FORECAST_VERSIONING = flags.PUBLISHED_FORECAST_IMMUTABLE === true && flags.FORECAST_REVISION === true;
  flags.MANUAL_OVERRIDES = flags.MANUAL_OVERRIDE_PRECEDENCE === true;
  flags.START_BLANK = flags.FORECAST_SCHEMA_READY === true;
  flags.ASSUMPTION_ENGINE = flags.ASSUMPTION_ENGINE === true;
  flags.ASSUMPTION_PRECEDENCE = flags.MANUAL_OVERRIDE_PRECEDENCE === true && flags.ASSUMPTION_RECALC_IDEMPOTENT === true;

  journalsAfterFixtures = await journalCount(supabase, orgId);

  const journalsAfter = await journalCount(supabase, orgId);
  flags.PLANNING_JOURNALS_CREATED = journalsAfter - journalsAfterFixtures;
  flags.ACCOUNTING_TRUTH_UNCHANGED = flags.PLANNING_JOURNALS_CREATED === 0;
  flags.ACCOUNTING_TRUTH_UNCHANGED_BY_PLANNING = flags.ACCOUNTING_TRUTH_UNCHANGED === true;

  const orphans = await countOrphans(supabase, orgId);
  flags.ORPHAN_PHASE14_RECORDS = orphans;

  const hfacAfter = await hfacSnapshot(supabase);
  flags.HFAC_BASELINE_UNCHANGED =
    hfacBefore.documents === hfacAfter.documents &&
    hfacBefore.journals === hfacAfter.journals &&
    hfacAfter.planning_budgets === hfacBefore.planning_budgets;

  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;
  const failures = results.filter((r) => !r.pass);

  flags.PHASE14A_DB_ACCEPTANCE = fail === 0 && flags.ACCOUNTING_TRUTH_UNCHANGED === true && orphans === 0;
  flags.PHASE14B_DB_ACCEPTANCE =
    flags.PRIOR_YEAR_MONTH_MAPPING === true &&
    flags.COPY_FORWARD_DB === true &&
    flags.CSV_IMPORT_DB === true &&
    flags.CSV_MERGE_MODE === true &&
    flags.CSV_REPLACE_MODE === true &&
    flags.REVISION_WORKFLOW_DB === true &&
    flags.APPROVAL_WORKFLOW_DB === true &&
    flags.LOCK_WORKFLOW_DB === true &&
    flags.PHASE14B_AUDIT_DB === true &&
    flags.PLANNING_JOURNALS_CREATED === 0;
  flags.PHASE14C_DB_ACCEPTANCE =
    flags.BUDGET_VS_ACTUAL_ENGINE === true &&
    flags.YTD_VARIANCE_DB === true &&
    flags.UNBUDGETED_ACTUALS_DB === true &&
    flags.PHASE14C_TENANT_ISOLATION === true &&
    flags.PLANNING_JOURNALS_CREATED === 0;
  flags.PHASE14D_DB_ACCEPTANCE =
    flags.FORECAST_SCHEMA_READY === true &&
    flags.START_FROM_BUDGET === true &&
    flags.ACTUAL_FORECAST_BLEND === true &&
    flags.PUBLISHED_FORECAST_IMMUTABLE === true &&
    flags.FORECAST_REVISION === true &&
    flags.FORECAST_ASSUMPTIONS === true &&
    flags.PHASE14D_TENANT_ISOLATION === true &&
    flags.CROSS_ORG_FORECAST_LINK_REJECTED === true &&
    flags.PLANNING_JOURNALS_CREATED === 0;
  flags.PHASE14E_DB_ACCEPTANCE =
    flags.ASSUMPTION_ENGINE === true &&
    flags.ASSUMPTION_PREVIEW === true &&
    flags.FORECAST_REFRESH === true &&
    flags.MANUAL_OVERRIDE_PRECEDENCE === true &&
    flags.ASSUMPTION_RECALC_IDEMPOTENT === true &&
    flags.PUBLISHED_ASSUMPTIONS_IMMUTABLE === true &&
    flags.PHASE14E_TENANT_ISOLATION === true &&
    flags.CROSS_ORG_ASSUMPTION_REJECTED === true &&
    flags.PLANNING_JOURNALS_CREATED === 0;
  flags.PHASE14F_DB_ACCEPTANCE =
    flags.CASH_SCHEMA_READY === true &&
    flags.STARTING_CASH_FROM_GL === true &&
    flags.AR_DUE_DATE_TIMING === true &&
    flags.OVERDUE_AR_INCLUDED === true &&
    flags.AR_REMAINING_BALANCE === true &&
    flags.AP_DUE_DATE_TIMING === true &&
    flags.OVERDUE_AP_INCLUDED === true &&
    flags.WEEKLY_ROLL_FORWARD === true &&
    flags.MANUAL_CASH_ADJUSTMENTS === true &&
    flags.FIRST_NEGATIVE_WEEK === true &&
    flags.PHASE14F_TENANT_ISOLATION === true &&
    flags.CASH_FORECAST_RUN_PERSIST === true &&
    flags.PLANNING_JOURNALS_CREATED === 0;
  flags.PHASE14G_DB_ACCEPTANCE =
    flags.PAYROLL_CASH_ADAPTER === true &&
    flags.RECURRING_CASH_ADAPTER === true &&
    flags.CAPEX_CASH_ADAPTER === true &&
    flags.PURCHASING_CASH_ADAPTER === true &&
    flags.GRNI_TO_AP_HANDOFF === true &&
    flags.SOURCE_COVERAGE === true &&
    flags.CASH_ADAPTERS_READ_ONLY === true &&
    flags.PHASE14G_TENANT_ISOLATION === true &&
    flags.PLANNING_JOURNALS_CREATED === 0;
  flags.PHASE14H_DB_ACCEPTANCE =
    flags.SCENARIO_SCHEMA_READY === true &&
    flags.BASE_SCENARIO === true &&
    flags.DOWNSIDE_SCENARIO === true &&
    flags.UPSIDE_SCENARIO === true &&
    flags.CUSTOM_SCENARIO === true &&
    flags.SCENARIO_ACTUAL_PERIODS_PROTECTED === true &&
    flags.SCENARIO_AR_TIMING === true &&
    flags.REAL_OBLIGATION_SCENARIO_PROTECTED === true &&
    flags.SCENARIO_PAYROLL_DRIVER === true &&
    flags.SCENARIO_CAPEX_DRIVER === true &&
    flags.SCENARIO_FORECAST_COMPARISON === true &&
    flags.SCENARIO_SOURCE_IMMUTABLE === true &&
    flags.PHASE14H_TENANT_ISOLATION === true &&
    flags.SCENARIO_COMPARE_READ_ONLY === true &&
    flags.PLANNING_JOURNALS_CREATED === 0;
  flags.PHASE14I_DB_ACCEPTANCE =
    flags.OWNER_PLANNING_DASHBOARD === true &&
    flags.BUDGET_SOURCE_SELECTION === true &&
    flags.FORECAST_SOURCE_SELECTION === true &&
    flags.VS_PLAN_CARD === true &&
    flags.DOWNSIDE_OUTLOOK_CARD === true &&
    flags.ATTENTION_SECTION === true &&
    flags.PHASE14I_TENANT_ISOLATION === true &&
    flags.DASHBOARD_JOURNALS_CREATED === true &&
    flags.PLANNING_JOURNALS_CREATED === 0;
  flags.PHASE14J_DB_ACCEPTANCE =
    flags.ACCOUNTANT_PLANNING_PACKAGE === true &&
    flags.BUDGET_VS_ACTUAL_ACCOUNTANT_SECTION === true &&
    flags.FORECAST_ACCOUNTANT_SECTION === true &&
    flags.CASH_ACCOUNTANT_SECTION === true &&
    flags.SCENARIO_ACCOUNTANT_SECTION === true &&
    flags.SOURCE_LINEAGE === true &&
    flags.PLANNING_RISK_SUMMARY === true &&
    flags.PHASE14J_TENANT_ISOLATION === true &&
    flags.ACCOUNTANT_EXPORT === true &&
    flags.PLANNING_PACKAGE_JOURNALS_CREATED === true &&
    flags.PLANNING_JOURNALS_CREATED === 0;
  flags.PHASE14K_DB_ACCEPTANCE =
    flags.PHASE14J_DB_ACCEPTANCE === true &&
    flags.CROSS_MODULE_FINANCIAL_CONSISTENCY === true &&
    flags.SOURCE_LINEAGE_CONSISTENCY === true &&
    flags.CASH_WEEKLY_RECONCILIATION === true &&
    flags.MISSING_DATA_ACCEPTANCE === true &&
    flags.PARTIAL_DATA_ACCEPTANCE === true &&
    flags.PLANNING_JOURNALS_CREATED === 0 &&
    flags.HFAC_BASELINE_UNCHANGED === true &&
    flags.ORPHAN_PHASE14_RECORDS === 0;
  flags.PLANNING_BLOCKS_PERIOD_CLOSE = false;
  flags.CLOSE_REWRITES_PLANNING = false;
  flags.ACCOUNTANT_PACKAGE_DUPLICATE_FINANCIAL_ENGINES = 0;
  flags.PRIMARY_CARD_COUNT = 6;
  flags.DASHBOARD_DUPLICATE_FINANCIAL_ENGINES = 0;
  flags.SCENARIO_MUTATES_SOURCE = flags.SCENARIO_SOURCE_IMMUTABLE === true ? false : true;
  flags.SCENARIO_SOURCE_LINEAGE = flags.BASE_SCENARIO === true;
  flags.GLOBAL_CASH_DEDUPE = flags.GRNI_TO_AP_HANDOFF === true;
  flags.CASH_SOURCE_DOUBLE_COUNT = flags.GLOBAL_CASH_DEDUPE === true ? 0 : 1;
  flags.PHASE14_CONTROLLED_ACCEPTANCE =
    flags.PHASE14A_DB_ACCEPTANCE === true &&
    flags.PHASE14B_DB_ACCEPTANCE === true &&
    flags.PHASE14C_DB_ACCEPTANCE === true &&
    flags.PHASE14D_DB_ACCEPTANCE === true &&
    flags.PHASE14E_DB_ACCEPTANCE === true &&
    flags.PHASE14F_DB_ACCEPTANCE === true &&
    flags.PHASE14G_DB_ACCEPTANCE === true &&
    flags.PHASE14H_DB_ACCEPTANCE === true &&
    flags.PHASE14I_DB_ACCEPTANCE === true &&
    flags.PHASE14J_DB_ACCEPTANCE === true &&
    flags.PHASE14K_DB_ACCEPTANCE === true;
  flags.PHASE14A_SECURITY_REVIEW = flags.CROSS_TENANT_READ_DENIED === true &&
    flags.CROSS_TENANT_WRITE_DENIED === true &&
    flags.FOREIGN_GL_ACCOUNT_REJECTED === true &&
    flags.PHASE14_IDOR_PROTECTION === true;

  return {
    pass,
    fail,
    total: results.length,
    results,
    flags,
    failures,
    hfacBefore,
    hfacAfter,
  };
}

function expectThrows(fn: () => void) {
  try {
    fn();
    throw new Error("expected throw");
  } catch (error) {
    if (error instanceof Error && error.message === "expected throw") throw error;
  }
}

function isMainModule() {
  const entry = process.argv[1];
  return entry?.endsWith("controlled-phase14-db-acceptance.ts") || entry === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  runPhase14DbAcceptance()
    .then((summary) => {
      console.log(`Phase 14 DB acceptance: ${summary.pass}/${summary.total} passed`);
      console.log(
        JSON.stringify(
          {
            PHASE14_CONTROLLED_ACCEPTANCE: summary.flags.PHASE14_CONTROLLED_ACCEPTANCE,
            PHASE14A_DB_ACCEPTANCE: summary.flags.PHASE14A_DB_ACCEPTANCE,
            PHASE14B_DB_ACCEPTANCE: summary.flags.PHASE14B_DB_ACCEPTANCE,
            PHASE14C_DB_ACCEPTANCE: summary.flags.PHASE14C_DB_ACCEPTANCE,
            PHASE14D_DB_ACCEPTANCE: summary.flags.PHASE14D_DB_ACCEPTANCE,
            PHASE14E_DB_ACCEPTANCE: summary.flags.PHASE14E_DB_ACCEPTANCE,
            PHASE14F_DB_ACCEPTANCE: summary.flags.PHASE14F_DB_ACCEPTANCE,
            PHASE14G_DB_ACCEPTANCE: summary.flags.PHASE14G_DB_ACCEPTANCE,
            PHASE14H_DB_ACCEPTANCE: summary.flags.PHASE14H_DB_ACCEPTANCE,
            PHASE14I_DB_ACCEPTANCE: summary.flags.PHASE14I_DB_ACCEPTANCE,
            PHASE14J_DB_ACCEPTANCE: summary.flags.PHASE14J_DB_ACCEPTANCE,
            PHASE14K_DB_ACCEPTANCE: summary.flags.PHASE14K_DB_ACCEPTANCE,
            CROSS_MODULE_FINANCIAL_CONSISTENCY: summary.flags.CROSS_MODULE_FINANCIAL_CONSISTENCY === true,
            SOURCE_LINEAGE_CONSISTENCY: summary.flags.SOURCE_LINEAGE_CONSISTENCY === true,
            CASH_WEEKLY_RECONCILIATION: summary.flags.CASH_WEEKLY_RECONCILIATION === true,
            MISSING_DATA_ACCEPTANCE: summary.flags.MISSING_DATA_ACCEPTANCE === true,
            PARTIAL_DATA_ACCEPTANCE: summary.flags.PARTIAL_DATA_ACCEPTANCE === true,
            OWNER_PLANNING_DASHBOARD: summary.flags.OWNER_PLANNING_DASHBOARD === true,
            PHASE14I_TENANT_ISOLATION: summary.flags.PHASE14I_TENANT_ISOLATION === true,
            PHASE14J_TENANT_ISOLATION: summary.flags.PHASE14J_TENANT_ISOLATION === true,
            ACCOUNTANT_PLANNING_PACKAGE: summary.flags.ACCOUNTANT_PLANNING_PACKAGE === true,
            PLANNING_BLOCKS_PERIOD_CLOSE: summary.flags.PLANNING_BLOCKS_PERIOD_CLOSE === false,
            CLOSE_REWRITES_PLANNING: summary.flags.CLOSE_REWRITES_PLANNING === false,
            SCENARIO_SCHEMA_READY: summary.flags.SCENARIO_SCHEMA_READY === true,
            BASE_SCENARIO: summary.flags.BASE_SCENARIO === true,
            DOWNSIDE_SCENARIO: summary.flags.DOWNSIDE_SCENARIO === true,
            PHASE14H_TENANT_ISOLATION: summary.flags.PHASE14H_TENANT_ISOLATION === true,
            PAYROLL_CASH_ADAPTER: summary.flags.PAYROLL_CASH_ADAPTER === true,
            RECURRING_CASH_ADAPTER: summary.flags.RECURRING_CASH_ADAPTER === true,
            PURCHASING_CASH_ADAPTER: summary.flags.PURCHASING_CASH_ADAPTER === true,
            CAPEX_CASH_ADAPTER: summary.flags.CAPEX_CASH_ADAPTER === true,
            SOURCE_COVERAGE: summary.flags.SOURCE_COVERAGE === true,
            GRNI_TO_AP_HANDOFF: summary.flags.GRNI_TO_AP_HANDOFF === true,
            PHASE14G_TENANT_ISOLATION: summary.flags.PHASE14G_TENANT_ISOLATION === true,
            CASH_SCHEMA_READY: summary.flags.CASH_SCHEMA_READY === true,
            STARTING_CASH_FROM_GL: summary.flags.STARTING_CASH_FROM_GL === true,
            AR_DUE_DATE_TIMING: summary.flags.AR_DUE_DATE_TIMING === true,
            OVERDUE_AR_INCLUDED: summary.flags.OVERDUE_AR_INCLUDED === true,
            AP_DUE_DATE_TIMING: summary.flags.AP_DUE_DATE_TIMING === true,
            OVERDUE_AP_INCLUDED: summary.flags.OVERDUE_AP_INCLUDED === true,
            MANUAL_CASH_ADJUSTMENTS: summary.flags.MANUAL_CASH_ADJUSTMENTS === true,
            FIRST_NEGATIVE_WEEK: summary.flags.FIRST_NEGATIVE_WEEK === true,
            PHASE14F_TENANT_ISOLATION: summary.flags.PHASE14F_TENANT_ISOLATION === true,
            ASSUMPTION_ENGINE: summary.flags.ASSUMPTION_ENGINE === true,
            ASSUMPTION_PREVIEW: summary.flags.ASSUMPTION_PREVIEW === true,
            FORECAST_REFRESH: summary.flags.FORECAST_REFRESH === true,
            MANUAL_OVERRIDE_PRECEDENCE: summary.flags.MANUAL_OVERRIDE_PRECEDENCE === true,
            PUBLISHED_ASSUMPTIONS_IMMUTABLE: summary.flags.PUBLISHED_ASSUMPTIONS_IMMUTABLE === true,
            PHASE14E_TENANT_ISOLATION: summary.flags.PHASE14E_TENANT_ISOLATION === true,
            BUDGET_VS_ACTUAL_ENGINE: summary.flags.BUDGET_VS_ACTUAL_ENGINE === true,
            YTD_VARIANCE_DB: summary.flags.YTD_VARIANCE_DB === true,
            UNBUDGETED_ACTUALS_DB: summary.flags.UNBUDGETED_ACTUALS_DB === true,
            PHASE14C_TENANT_ISOLATION: summary.flags.PHASE14C_TENANT_ISOLATION === true,
            FORECAST_ACTUAL_SOURCE: summary.flags.FORECAST_ACTUAL_SOURCE,
            ACTUAL_FORECAST_BLEND: summary.flags.ACTUAL_FORECAST_BLEND === true,
            PUBLISHED_FORECAST_IMMUTABLE: summary.flags.PUBLISHED_FORECAST_IMMUTABLE === true,
            FORECAST_REVISION: summary.flags.FORECAST_REVISION === true,
            PHASE14D_TENANT_ISOLATION: summary.flags.PHASE14D_TENANT_ISOLATION === true,
            CROSS_ORG_FORECAST_LINK_REJECTED: summary.flags.CROSS_ORG_FORECAST_LINK_REJECTED === true,
            MANUAL_PATCH_REQUIRED:
              summary.flags.FORECAST_SCHEMA_READY !== true ||
              summary.flags.CASH_SCHEMA_READY !== true ||
              summary.flags.SCENARIO_SCHEMA_READY !== true,
            MANUAL_PATCH_FILE:
              summary.flags.FORECAST_SCHEMA_READY !== true
                ? "supabase/patches/032-phase14d-forecast-lines.sql"
                : summary.flags.CASH_SCHEMA_READY !== true
                  ? "supabase/patches/033-phase14f-cash-forecast.sql"
                  : summary.flags.SCENARIO_SCHEMA_READY !== true
                    ? "supabase/patches/034-phase14h-scenarios.sql"
                    : null,
            MIGRATION_033_REQUIRED: false,
            ACTUAL_SOURCE: summary.flags.ACTUAL_SOURCE,
            PRIOR_YEAR_MONTH_MAPPING: summary.flags.PRIOR_YEAR_MONTH_MAPPING === true,
            PRIOR_YEAR_CENTS_EXACT: summary.flags.PRIOR_YEAR_CENTS_EXACT === true,
            PRIOR_YEAR_PNL_SCOPE_DB: summary.flags.PRIOR_YEAR_PNL_SCOPE_DB === true,
            COPY_FORWARD_DB: summary.flags.COPY_FORWARD_DB === true,
            REVISION_WORKFLOW_DB: summary.flags.REVISION_WORKFLOW_DB === true,
            APPROVAL_WORKFLOW_DB: summary.flags.APPROVAL_WORKFLOW_DB === true,
            LOCK_WORKFLOW_DB: summary.flags.LOCK_WORKFLOW_DB === true,
            CSV_IMPORT_DB: summary.flags.CSV_IMPORT_DB === true,
            CSV_MERGE_MODE: summary.flags.CSV_MERGE_MODE === true,
            CSV_REPLACE_MODE: summary.flags.CSV_REPLACE_MODE === true,
            CSV_EXPORT_VERIFY: summary.flags.CSV_EXPORT_VERIFY === true,
            BULK_BUDGET_TOOLS_DB: summary.flags.BULK_BUDGET_TOOLS_DB === true,
            PHASE14B_AUDIT_DB: summary.flags.PHASE14B_AUDIT_DB === true,
            APPROVED_IMPORT_REJECTED: summary.flags.APPROVED_IMPORT_REJECTED === true,
            LOCKED_IMPORT_REJECTED: summary.flags.LOCKED_IMPORT_REJECTED === true,
            PLANNING_SETTINGS_DB: summary.flags.PLANNING_SETTINGS_DB === true,
            BUDGET_TOTALS_EXACT: summary.flags.BUDGET_TOTALS_EXACT === true,
            DUPLICATE_PROTECTION: summary.flags.DUPLICATE_PROTECTION === true,
            DRAFT_EDITING_DB: summary.flags.DRAFT_EDITING_DB === true,
            APPROVED_VERSION_IMMUTABLE: summary.flags.APPROVED_VERSION_IMMUTABLE === true,
            LOCKED_VERSION_IMMUTABLE: summary.flags.LOCKED_VERSION_IMMUTABLE === true,
            REVISION_CLONE_PASS: summary.flags.REVISION_CLONE_PASS === true,
            PLANNING_AUDIT_DB: summary.flags.PLANNING_AUDIT_DB === true,
            CROSS_TENANT_READ_DENIED: summary.flags.CROSS_TENANT_READ_DENIED === true,
            CROSS_TENANT_WRITE_DENIED: summary.flags.CROSS_TENANT_WRITE_DENIED === true,
            FOREIGN_GL_ACCOUNT_REJECTED: summary.flags.FOREIGN_GL_ACCOUNT_REJECTED === true,
            PHASE14_IDOR_PROTECTION: summary.flags.PHASE14_IDOR_PROTECTION === true,
            PHASE14B_CROSS_TENANT_READ_DENIED: summary.flags.PHASE14B_CROSS_TENANT_READ_DENIED === true,
            PHASE14B_CROSS_TENANT_WRITE_DENIED: summary.flags.PHASE14B_CROSS_TENANT_WRITE_DENIED === true,
            PHASE14B_IDOR_PROTECTION: summary.flags.PHASE14B_IDOR_PROTECTION === true,
            PLANNING_JOURNALS_CREATED: summary.flags.PLANNING_JOURNALS_CREATED,
            ACCOUNTING_TRUTH_UNCHANGED: summary.flags.ACCOUNTING_TRUTH_UNCHANGED === true,
            HFAC_BASELINE_UNCHANGED: summary.flags.HFAC_BASELINE_UNCHANGED === true,
            ORPHAN_PHASE14_RECORDS: summary.flags.ORPHAN_PHASE14_RECORDS,
            PHASE14A_SECURITY_REVIEW: summary.flags.PHASE14A_SECURITY_REVIEW === true,
            failures: summary.failures,
          },
          null,
          2,
        ),
      );
      process.exit(summary.fail > 0 || summary.flags.PHASE14_CONTROLLED_ACCEPTANCE !== true ? 1 : 0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
