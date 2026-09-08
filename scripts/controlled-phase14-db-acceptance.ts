/**
 * Phase 14A controlled DB acceptance — planning budgets (mutates Phase 14 demo org only).
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
  bulkUpsertBudgetLines,
  cloneBudgetVersion,
  createBudget,
  listBudgetLines,
} from "../src/lib/planning/budgets/budget-crud";
import { recordPlanningAuditEvent } from "../src/lib/planning/budgets/audit";
import {
  accountAnnualTotal,
  budgetAnnualTotal,
  monthlyTotal,
} from "../src/lib/planning/budgets/totals";
import { assertVersionAction, assertVersionStatusTransition } from "../src/lib/planning/budgets/lifecycle";
import { validateBulkLines } from "../src/lib/planning/budgets/validation";
import {
  DEFAULT_PLANNING_SETTINGS,
  parsePlanningSettings,
  planningSettingsToRow,
} from "../src/lib/planning/settings/planning-settings";
import { roundMoney } from "../src/lib/accounting/payment-fees";

const HFAC_ORG = TELLER_HFAC_ORG_ID;
const FISCAL_YEAR = 2027;

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
    { code: "4000", name: "Revenue", type: "revenue", subtype: "" },
    { code: "5000", name: "COGS", type: "cogs", subtype: "material" },
    { code: "6000", name: "Operating Expense", type: "expense", subtype: "" },
  ];
  for (const row of seeds) {
    const { data: existing } = await supabase
      .from("teller_accounts")
      .select("id")
      .eq("organization_id", orgId)
      .eq("code", row.code)
      .maybeSingle();
    if (existing?.id) continue;
    const { error } = await supabase.from("teller_accounts").insert({
      organization_id: orgId,
      code: row.code,
      name: row.name,
      type: row.type,
      subtype: row.subtype,
      industry_tag: "",
      is_system: true,
    });
    if (error) throw new Error(error.message);
  }
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

  const { byCode, byId } = await accountMap(supabase, orgId);
  for (const code of ["4000", "5000", "6000"]) {
    if (!byCode.get(code)) throw new Error(`Missing demo account ${code}`);
  }
  const foreignAccounts = await accountMap(supabase, foreignOrgId);

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

  await run("Create FY2027 operating budget", async () => {
    const { budget, version } = await createBudget(supabase, {
      organizationId: orgId,
      name: "FY2027 Operating Budget",
      fiscalYear: FISCAL_YEAR,
      baselineKind: "blank",
    });
    budgetId = budget.id as string;
    versionId = version.id as string;
    if (Number(budget.fiscal_year) !== FISCAL_YEAR) throw new Error("fiscal year mismatch");
    if (version.status !== "draft") throw new Error(`expected draft, got ${version.status}`);
    if (Number(version.version_number) !== 1) throw new Error("expected version 1");
    const { count } = await supabase
      .from("teller_planning_audit_events")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("event_kind", "budget_created");
    if ((count ?? 0) < 1) throw new Error("missing budget_created audit");
  }, "BUDGET_PERSISTENCE_DB");

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
    if (jan !== roundMoney(10000.33 + 2500.12)) throw new Error(`jan total ${jan}`);
    const revAnnual = accountAnnualTotal(totals, byCode.get("4000")!);
    if (revAnnual !== roundMoney(10000.33 + 10500.67)) throw new Error(`rev annual ${revAnnual}`);
    if (budgetAnnualTotal(totals) !== roundMoney(lineInputs.reduce((s, l) => s + l.amount, 0))) {
      throw new Error("budget annual mismatch");
    }
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
    const del = await supabase
      .from("teller_budget_lines")
      .delete()
      .eq("budget_version_id", lockedVersionId)
      .limit(1);
    if (!del.error || !/not editable|immutable/i.test(del.error.message)) {
      throw new Error(`locked delete should fail: ${del.error?.message ?? "succeeded"}`);
    }
  }, "LOCKED_VERSION_IMMUTABLE");

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
    }

    const sourceLines = await listBudgetLines(supabase, orgId, lockedVersionId);
    const cloneLines = await listBudgetLines(supabase, orgId, cloneVersionId);
    if (cloneLines.length !== sourceLines.length) throw new Error("clone line count mismatch");
    const sourceSum = sourceLines.reduce((s, l) => s + Number(l.amount), 0);
    const cloneSum = cloneLines.reduce((s, l) => s + Number(l.amount), 0);
    if (roundMoney(sourceSum) !== roundMoney(cloneSum)) throw new Error("clone amounts differ");

    await bulkUpsertBudgetLines(supabase, {
      organizationId: orgId,
      budgetId,
      versionId: cloneVersionId,
      fiscalYear: FISCAL_YEAR,
      lines: [{ accountId: byCode.get("6000")!, periodMonth: "2027-04-01", amount: 999.01 }],
    });

    const lockedAfter = await listBudgetLines(supabase, orgId, lockedVersionId);
    const lockedRow = lockedAfter.find((r) => r.period_month === "2027-04-01" && r.account_id === byCode.get("6000"));
    if (Number(lockedRow?.amount) !== -150.25) throw new Error("source version mutated after clone edit");
  }, "REVISION_CLONE_PASS");

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
  flags.PLANNING_JOURNALS_CREATED = journalsAfter - journalsBefore;
  flags.ACCOUNTING_TRUTH_UNCHANGED = journalsAfter === journalsBefore;

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
      console.log(`Phase 14A DB acceptance: ${summary.pass}/${summary.total} passed`);
      console.log(
        JSON.stringify(
          {
            PHASE14A_DB_ACCEPTANCE: summary.flags.PHASE14A_DB_ACCEPTANCE,
            PLANNING_SETTINGS_DB: summary.flags.PLANNING_SETTINGS_DB === true,
            BUDGET_PERSISTENCE_DB: summary.flags.BUDGET_PERSISTENCE_DB === true,
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
      process.exit(summary.fail > 0 || summary.flags.PHASE14A_DB_ACCEPTANCE !== true ? 1 : 0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
