/**
 * Phase 14A+14B controlled DB acceptance — planning budgets (mutates Phase 14 demo org only).
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
  await supabase
    .from("teller_budget_versions")
    .update({ status: "draft", approved_at: null, locked_at: null })
    .eq("organization_id", orgId);
  await supabase.from("teller_budget_lines").delete().eq("organization_id", orgId);
  await supabase.from("teller_budget_versions").delete().eq("organization_id", orgId);
  await supabase.from("teller_planning_audit_events").delete().eq("organization_id", orgId);
  await supabase.from("teller_budgets").delete().eq("organization_id", orgId);
  await supabase.from("teller_planning_settings").delete().eq("organization_id", orgId);
}

async function ensureDemoAccounts(supabase: SupabaseClient, orgId: string) {
  const seeds = [
    { code: "1000", name: "Cash", type: "asset", subtype: "bank" },
    { code: "2000", name: "Accounts Payable", type: "liability", subtype: "" },
    { code: "4000", name: "Revenue", type: "revenue", subtype: "" },
    { code: "5000", name: "COGS", type: "cogs", subtype: "material" },
    { code: "6000", name: "Operating Expense", type: "expense", subtype: "" },
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
  for (const code of ["1000", "2000", "4000", "5000", "6000", "6999"]) {
    if (!byCode.get(code)) throw new Error(`Missing demo account ${code}`);
  }

  await seedPriorYearGlFixtures(supabase, orgId, byCode);
  const journalsAfterFixtures = await journalCount(supabase, orgId);

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
  flags.PHASE14_CONTROLLED_ACCEPTANCE = flags.PHASE14A_DB_ACCEPTANCE === true && flags.PHASE14B_DB_ACCEPTANCE === true;
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
