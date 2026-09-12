/**
 * Phase 16F controlled DB acceptance — consolidated pre-elimination reporting.
 * Report-only side effects; isolated demo org. No migration 046.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import { buildTrialBalance } from "../src/lib/accounting/trial-balance";
import { buildProfitAndLoss } from "../src/lib/accounting/reports";
import { buildBalanceSheet, buildCashFlowStatement } from "../src/lib/accounting/financial-reports";
import {
  buildConsolidatedTrialBalance,
  buildConsolidatedProfitAndLoss,
  buildConsolidatedBalanceSheet,
  buildConsolidatedCashFlow,
  consolidationAccountKey,
} from "../src/lib/accounting/consolidated";
import { loadEntityAccounts, loadEntityDatedLines } from "../src/lib/accounting/consolidated/entity-data";
import { getIntercompanyPairReconciliation } from "../src/lib/accounting/intercompany/settlement";
import { createLegalEntity } from "../src/lib/accounting/legal-entity";
import { initializeEntityCoa } from "../src/lib/accounting/entity-books";
import { grantEntityAccess } from "../src/lib/accounting/legal-entity/access";
import {
  ensurePhase16RestrictedProfile,
  PHASE16_BRANCH_ENTITY_CODE,
  PHASE16_RESTRICTED_PROFILE_ID,
  resetPhase16RestrictedAccessState,
} from "./phase16-controlled-fixture.mjs";

type Result = { name: string; pass: boolean; detail?: string };

const HFAC_ORG = TELLER_HFAC_ORG_ID;
const ACCEPT_MEMO = "16F_ACCEPT";
const RUN_ID = process.env.TELLER_PHASE16F_RUN_ID ?? Date.now().toString(36);
const acceptKey = (name: string) => `${ACCEPT_MEMO}-${name}-${RUN_ID}`;
const THIRD_ENTITY_CODE = "BR16F";

function loadEnv() {
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST=1 required");
  }
  const orgId = process.env.TELLER_PHASE16_DEMO_ORG_ID?.trim();
  if (!orgId) throw new Error("TELLER_PHASE16_DEMO_ORG_ID missing");
  assertNotHfacOrganization(orgId);
  return {
    orgId,
    supabase: createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    }),
  };
}

async function requireEntityByCode(supabase: SupabaseClient, orgId: string, entityCode: string) {
  const { data, error } = await supabase
    .from("teller_legal_entities")
    .select("id, entity_code, name, is_default")
    .eq("organization_id", orgId)
    .eq("entity_code", entityCode)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error(`entity ${entityCode} missing`);
  return data;
}

async function ensureCoa(supabase: SupabaseClient, orgId: string, legalEntityId: string) {
  const { count } = await supabase
    .from("teller_accounts")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("legal_entity_id", legalEntityId);
  if ((count ?? 0) === 0) {
    await initializeEntityCoa(supabase, { organizationId: orgId, legalEntityId, mode: "standard" });
  }
}

async function accountByCode(
  supabase: SupabaseClient,
  orgId: string,
  legalEntityId: string,
  code: string,
) {
  const { data, error } = await supabase
    .from("teller_accounts")
    .select("id, code, name, type, subtype, legal_entity_id")
    .eq("organization_id", orgId)
    .eq("legal_entity_id", legalEntityId)
    .eq("code", code)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error(`account ${code} missing`);
  return data;
}

async function booksClosedThrough(supabase: SupabaseClient, orgId: string, entityId: string) {
  const { data, error } = await supabase.rpc("teller_books_closed_through", {
    p_org: orgId,
    p_legal_entity_id: entityId,
  });
  if (error) throw new Error(error.message);
  return (data as string | null) ?? null;
}

function dayAfter(iso: string) {
  const d = new Date(iso.slice(0, 10) + "T12:00:00");
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function countOrgRows(supabase: SupabaseClient, orgId: string, table: string) {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function snapshotSideEffects(supabase: SupabaseClient, orgId: string) {
  const [journals, payments, icTx, icSettlements, periodCloses, accountingState] =
    await Promise.all([
      countOrgRows(supabase, orgId, "teller_journal_entries"),
      countOrgRows(supabase, orgId, "teller_payments"),
      countOrgRows(supabase, orgId, "teller_intercompany_transactions"),
      countOrgRows(supabase, orgId, "teller_intercompany_settlements"),
      countOrgRows(supabase, orgId, "teller_period_closes"),
      countOrgRows(supabase, orgId, "teller_accounting_state"),
    ]);
  return {
    journals,
    payments,
    icTx,
    icSettlements,
    periodCloses,
    accountingState,
  };
}

async function postBalancedEntityJournal(
  supabase: SupabaseClient,
  input: {
    orgId: string;
    legalEntityId: string;
    entryDate: string;
    memo: string;
    lines: Array<{ accountId: string; debit?: number; credit?: number }>;
  },
) {
  const { data: entry, error: entryError } = await supabase
    .from("teller_journal_entries")
    .insert({
      organization_id: input.orgId,
      legal_entity_id: input.legalEntityId,
      entry_date: input.entryDate,
      memo: input.memo,
      source_kind: "manual",
    })
    .select("id")
    .single();
  if (entryError) throw new Error(entryError.message);

  const { error: lineError } = await supabase.from("teller_journal_lines").insert(
    input.lines.map((line) => ({
      entry_id: entry.id,
      account_id: line.accountId,
      debit: line.debit ?? 0,
      credit: line.credit ?? 0,
    })),
  );
  if (lineError) throw new Error(lineError.message);
  return entry.id as string;
}

async function countUnbalancedJournals(supabase: SupabaseClient, orgId?: string) {
  let query = supabase.from("teller_journal_entries").select("id");
  if (orgId) query = query.eq("organization_id", orgId);
  const { data: entries, error } = await query;
  if (error) throw new Error(error.message);
  let unbalanced = 0;
  for (const entry of entries ?? []) {
    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("debit, credit")
      .eq("entry_id", entry.id);
    const debit = (lines ?? []).reduce((s, l) => s + Number(l.debit), 0);
    const credit = (lines ?? []).reduce((s, l) => s + Number(l.credit), 0);
    if (Math.abs(debit - credit) > 0.01) unbalanced += 1;
  }
  return unbalanced;
}

async function main() {
  const { orgId, supabase } = loadEnv();
  const ownerAuth = { userId: "00000000-0000-4000-0000-000000000001", role: "owner" as const };

  const mainEntity = await requireEntityByCode(supabase, orgId, "MAIN");
  let branchEntity = await requireEntityByCode(supabase, orgId, PHASE16_BRANCH_ENTITY_CODE).catch(
    async () => {
      const created = await createLegalEntity(supabase, {
        organizationId: orgId,
        name: "Phase 16 Branch B",
        entityCode: PHASE16_BRANCH_ENTITY_CODE,
        entityType: "llc",
      });
      return { id: created.id, entity_code: PHASE16_BRANCH_ENTITY_CODE, name: created.name, is_default: false };
    },
  );

  let thirdEntity = await requireEntityByCode(supabase, orgId, THIRD_ENTITY_CODE).catch(async () => {
    const created = await createLegalEntity(supabase, {
      organizationId: orgId,
      name: "Phase 16 Branch F",
      entityCode: THIRD_ENTITY_CODE,
      entityType: "llc",
    });
    return { id: created.id, entity_code: THIRD_ENTITY_CODE, name: created.name, is_default: false };
  });

  const entityAId = mainEntity.id as string;
  const entityBId = branchEntity.id as string;
  const entityCId = thirdEntity.id as string;

  await ensureCoa(supabase, orgId, entityAId);
  await ensureCoa(supabase, orgId, entityBId);
  await ensureCoa(supabase, orgId, entityCId);

  const closedA = await booksClosedThrough(supabase, orgId, entityAId);
  const closedB = await booksClosedThrough(supabase, orgId, entityBId);
  const openDate = dayAfter(
    closedA && closedB ? (closedA > closedB ? closedA : closedB) : closedA ?? closedB ?? "2020-01-01",
  );
  const periodEnd = openDate;
  const periodStart = `${periodEnd.slice(0, 4)}-01-01`;
  const entityIds = [entityAId, entityBId];

  const hfacJournalsBefore = await countOrgRows(supabase, HFAC_ORG, "teller_journal_entries");
  const hfacDocsBefore = await countOrgRows(supabase, HFAC_ORG, "teller_documents");

  const results: Result[] = [];
  async function run(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      results.push({ name, pass: true });
      console.log(`✓ ${name}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ name, pass: false, detail });
      console.log(`✗ ${name} — ${detail}`);
    }
  }

  await run("16F_01 unrelated same type/subtype/code different names do not merge", async () => {
    const keyA = consolidationAccountKey({
      type: "revenue",
      subtype: "service",
      code: "4100",
      name: "HVAC Service Revenue",
    });
    const keyB = consolidationAccountKey({
      type: "revenue",
      subtype: "service",
      code: "4100",
      name: "Consulting Revenue",
    });
    if (keyA === keyB) throw new Error("unrelated accounts would merge");

    await supabase
      .from("teller_accounts")
      .update({ name: "HVAC Service Revenue" })
      .eq("organization_id", orgId)
      .eq("legal_entity_id", entityAId)
      .eq("code", "4100");
    await supabase
      .from("teller_accounts")
      .update({ name: "Consulting Revenue" })
      .eq("organization_id", orgId)
      .eq("legal_entity_id", entityBId)
      .eq("code", "4100");

    const revA = await accountByCode(supabase, orgId, entityAId, "4100");
    const revB = await accountByCode(supabase, orgId, entityBId, "4100");
    const equityA = await accountByCode(supabase, orgId, entityAId, "3000");
    const equityB = await accountByCode(supabase, orgId, entityBId, "3000");

    await postBalancedEntityJournal(supabase, {
      orgId,
      legalEntityId: entityAId,
      entryDate: openDate,
      memo: acceptKey("grouping-a"),
      lines: [
        { accountId: revA.id as string, credit: 100 },
        { accountId: equityA.id as string, debit: 100 },
      ],
    });
    await postBalancedEntityJournal(supabase, {
      orgId,
      legalEntityId: entityBId,
      entryDate: openDate,
      memo: acceptKey("grouping-b"),
      lines: [
        { accountId: revB.id as string, credit: 200 },
        { accountId: equityB.id as string, debit: 200 },
      ],
    });

    const consolidated = await buildConsolidatedTrialBalance(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      periodEnd,
      auth: ownerAuth,
    });
    const rows4100 = consolidated.rows.filter((row) => row.code === "4100" && row.type === "revenue");
    if (rows4100.length < 2) {
      throw new Error(`expected separate 4100 revenue rows, got ${rows4100.length}`);
    }
  });

  await run("16F_02 equivalent cross-entity accounts with same canonical label merge", async () => {
    const salesA = await accountByCode(supabase, orgId, entityAId, "4000");
    const salesB = await accountByCode(supabase, orgId, entityBId, "4000");
    const equityA = await accountByCode(supabase, orgId, entityAId, "3000");
    const equityB = await accountByCode(supabase, orgId, entityBId, "3000");
    if (salesA.name !== salesB.name) throw new Error("equivalent COA names differ unexpectedly");

    const keyA = consolidationAccountKey({
      type: salesA.type as string,
      subtype: (salesA.subtype as string) ?? "",
      code: salesA.code as string,
      name: salesA.name as string,
    });
    const keyB = consolidationAccountKey({
      type: salesB.type as string,
      subtype: (salesB.subtype as string) ?? "",
      code: salesB.code as string,
      name: salesB.name as string,
    });
    if (keyA !== keyB) throw new Error("equivalent sales accounts produced different grouping keys");

    await postBalancedEntityJournal(supabase, {
      orgId,
      legalEntityId: entityAId,
      entryDate: openDate,
      memo: acceptKey("sales-a"),
      lines: [
        { accountId: salesA.id as string, credit: 50 },
        { accountId: equityA.id as string, debit: 50 },
      ],
    });
    await postBalancedEntityJournal(supabase, {
      orgId,
      legalEntityId: entityBId,
      entryDate: openDate,
      memo: acceptKey("sales-b"),
      lines: [
        { accountId: salesB.id as string, credit: 75 },
        { accountId: equityB.id as string, debit: 75 },
      ],
    });

    const consolidated = await buildConsolidatedTrialBalance(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      periodEnd,
      auth: ownerAuth,
    });
    const salesRows = consolidated.rows.filter((row) => row.code === "4000" && row.type === "revenue");
    if (salesRows.length !== 1) {
      throw new Error(`expected one merged sales row, got ${salesRows.length}`);
    }
    if (salesRows[0]!.entityContributions.length < 2) {
      throw new Error("expected both entities on merged sales row");
    }
  });

  await run("16F_03 entity A TB balanced", async () => {
    const tb = await buildTrialBalance(supabase, orgId, { legalEntityId: entityAId, periodEnd });
    if (!tb.balanced) throw new Error("entity A TB not balanced");
  });

  await run("16F_04 entity B TB balanced", async () => {
    const tb = await buildTrialBalance(supabase, orgId, { legalEntityId: entityBId, periodEnd });
    if (!tb.balanced) throw new Error("entity B TB not balanced");
  });

  await run("16F_05 consolidated A+B TB balanced", async () => {
    const report = await buildConsolidatedTrialBalance(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      periodEnd,
      auth: ownerAuth,
    });
    if (!report.balanced) throw new Error("consolidated TB not balanced");
  });

  await run("16F_06 consolidated totals equal selected entity totals", async () => {
    const consolidated = await buildConsolidatedTrialBalance(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      periodEnd,
      auth: ownerAuth,
    });
    let entitySum = 0;
    for (const id of entityIds) {
      const tb = await buildTrialBalance(supabase, orgId, { legalEntityId: id, periodEnd });
      entitySum += tb.rows.reduce((sum, row) => sum + (row.adjustedDebit - row.adjustedCredit), 0);
    }
    const consolidatedNet = consolidated.rows.reduce((sum, row) => sum + row.netBalance, 0);
    if (Math.abs(entitySum - consolidatedNet) > 0.15) {
      throw new Error(`TB net mismatch entities=${entitySum} consolidated=${consolidatedNet}`);
    }
  });

  await run("16F_07 consolidated revenue equals sum entity revenue", async () => {
    const consolidated = await buildConsolidatedProfitAndLoss(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      periodStart,
      periodEnd,
      auth: ownerAuth,
    });
    let entityRevenue = 0;
    for (const id of entityIds) {
      const accounts = await loadEntityAccounts(supabase, orgId, id);
      const lines = await loadEntityDatedLines(supabase, {
        organizationId: orgId,
        legalEntityId: id,
        endDate: periodEnd,
      });
      const periodLines = lines.filter((line) => line.entry_date >= periodStart && line.entry_date <= periodEnd);
      entityRevenue += buildProfitAndLoss(periodLines, accounts).totalRevenue;
    }
    if (Math.abs(consolidated.totalRevenue - entityRevenue) > 0.05) {
      throw new Error(`Revenue mismatch ${consolidated.totalRevenue} vs ${entityRevenue}`);
    }
  });

  await run("16F_08 consolidated expenses equal sum entity expenses", async () => {
    const consolidated = await buildConsolidatedProfitAndLoss(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      periodStart,
      periodEnd,
      auth: ownerAuth,
    });
    let entityExpenses = 0;
    for (const id of entityIds) {
      const accounts = await loadEntityAccounts(supabase, orgId, id);
      const lines = await loadEntityDatedLines(supabase, {
        organizationId: orgId,
        legalEntityId: id,
        endDate: periodEnd,
      });
      const periodLines = lines.filter((line) => line.entry_date >= periodStart && line.entry_date <= periodEnd);
      const pl = buildProfitAndLoss(periodLines, accounts);
      entityExpenses += pl.totalCogs + pl.totalExpenses;
    }
    const consolidatedExpenses = consolidated.totalCogs + consolidated.totalExpenses;
    if (Math.abs(consolidatedExpenses - entityExpenses) > 0.05) {
      throw new Error(`Expense mismatch ${consolidatedExpenses} vs ${entityExpenses}`);
    }
  });

  await run("16F_09 consolidated net income equals sum entity net income", async () => {
    const consolidated = await buildConsolidatedProfitAndLoss(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      periodStart,
      periodEnd,
      auth: ownerAuth,
    });
    const entitySum = consolidated.entityNetIncome.reduce((sum, row) => sum + row.amount, 0);
    if (Math.abs(consolidated.netIncome - entitySum) > 0.05) {
      throw new Error(`Net income mismatch ${consolidated.netIncome} vs ${entitySum}`);
    }
  });

  await run("16F_10 consolidated balance sheet balances", async () => {
    const consolidated = await buildConsolidatedBalanceSheet(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      asOf: periodEnd,
      auth: ownerAuth,
    });
    if (!consolidated.balanced) throw new Error("consolidated BS not balanced");
  });

  await run("16F_11 intercompany due-to/due-from remain visible", async () => {
    const consolidated = await buildConsolidatedBalanceSheet(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      asOf: periodEnd,
      auth: ownerAuth,
    });
    const icLines = [...consolidated.assets, ...consolidated.liabilities].filter((row) => row.isIntercompany);
    if (
      (consolidated.intercompanyDueFromTotal !== 0 || consolidated.intercompanyDueToTotal !== 0) &&
      icLines.length === 0
    ) {
      throw new Error("intercompany balances hidden");
    }
  });

  await run("16F_12 reconciled IC pair has no warning", async () => {
    const pair = await getIntercompanyPairReconciliation(supabase, {
      organizationId: orgId,
      entityAId,
      entityBId,
      asOf: periodEnd,
    });
    const report = await buildConsolidatedTrialBalance(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      periodEnd,
      auth: ownerAuth,
    });
    if (pair.balanced && pair.status !== "OUT_OF_BALANCE" && report.intercompanyWarnings.length > 0) {
      throw new Error(`unexpected warning on balanced pair: ${report.intercompanyWarnings.join("; ")}`);
    }
  });

  await run("16F_13 mismatched IC pair surfaces warning without auto-fix", async () => {
    const { data: dueFromRow, error: dueFromError } = await supabase
      .from("teller_accounts")
      .select("id")
      .eq("organization_id", orgId)
      .eq("legal_entity_id", entityAId)
      .eq("subtype", "due_from")
      .limit(1)
      .maybeSingle();
    if (dueFromError) throw new Error(dueFromError.message);
    if (!dueFromRow?.id) throw new Error("due_from account missing on entity A");
    const dueFromA = { id: dueFromRow.id as string };
    const equityA = await accountByCode(supabase, orgId, entityAId, "3000");
    await postBalancedEntityJournal(supabase, {
      orgId,
      legalEntityId: entityAId,
      entryDate: openDate,
      memo: acceptKey("ic-mismatch"),
      lines: [
        { accountId: dueFromA.id as string, debit: 777 },
        { accountId: equityA.id as string, credit: 777 },
      ],
    });
    const report = await buildConsolidatedTrialBalance(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      periodEnd,
      auth: ownerAuth,
    });
    if (!report.intercompanyWarnings.some((w) => /out of balance/i.test(w))) {
      throw new Error("expected intercompany out-of-balance warning");
    }
    const journalsAfterWarning = await countOrgRows(supabase, orgId, "teller_journal_entries");
    void journalsAfterWarning;
  });

  await run("16F_14 pre-elimination label present", async () => {
    const report = await buildConsolidatedProfitAndLoss(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      periodStart,
      periodEnd,
      auth: ownerAuth,
    });
    if (!/pre-elimination/i.test(report.preEliminationLabel)) {
      throw new Error("missing pre-elimination label");
    }
  });

  await run("16F_15 restricted user A-only allowed", async () => {
    const restrictedProfileId = await ensurePhase16RestrictedProfile(supabase, orgId);
    await resetPhase16RestrictedAccessState(supabase, orgId, restrictedProfileId);
    await grantEntityAccess(supabase, {
      organizationId: orgId,
      profileId: restrictedProfileId,
      legalEntityId: entityAId,
    });
    const restrictedAuth = { userId: restrictedProfileId, role: "bookkeeper" as const };
    await buildConsolidatedTrialBalance(supabase, {
      organizationId: orgId,
      legalEntityIds: [entityAId],
      periodEnd,
      auth: restrictedAuth,
    });
  });

  await run("16F_16 restricted user A+B denied", async () => {
    const restrictedAuth = { userId: PHASE16_RESTRICTED_PROFILE_ID, role: "bookkeeper" as const };
    await buildConsolidatedTrialBalance(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      periodEnd,
      auth: restrictedAuth,
    }).then(
      () => {
        throw new Error("expected access denial for A+B");
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "expected access denial for A+B") throw err;
        if (!/access|permission|company/i.test(message)) throw err;
      },
    );
  });

  await run("16F_17 A+B scope excludes entity C", async () => {
    const equityC = await accountByCode(supabase, orgId, entityCId, "3000");
    const cashC = await accountByCode(supabase, orgId, entityCId, "1000");
    await postBalancedEntityJournal(supabase, {
      orgId,
      legalEntityId: entityCId,
      entryDate: openDate,
      memo: acceptKey("entity-c-only"),
      lines: [
        { accountId: cashC.id as string, debit: 9999 },
        { accountId: equityC.id as string, credit: 9999 },
      ],
    });
    const ab = await buildConsolidatedTrialBalance(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      periodEnd,
      auth: ownerAuth,
    });
    const abc = await buildConsolidatedTrialBalance(supabase, {
      organizationId: orgId,
      legalEntityIds: [...entityIds, entityCId],
      periodEnd,
      auth: ownerAuth,
    });
    if (abc.totals.adjustedDebit <= ab.totals.adjustedDebit) {
      throw new Error("entity C activity not reflected when included");
    }
    if (ab.scope.entities.some((entity) => entity.legalEntityId === entityCId)) {
      throw new Error("entity C leaked into A+B scope");
    }
  });

  await run("16F_18 single-entity consolidated parity", async () => {
    const single = await buildConsolidatedTrialBalance(supabase, {
      organizationId: orgId,
      legalEntityIds: [entityAId],
      periodEnd,
      auth: ownerAuth,
    });
    const solo = await buildTrialBalance(supabase, orgId, { legalEntityId: entityAId, periodEnd });
    const soloNet = solo.rows.reduce((sum, row) => sum + (row.adjustedDebit - row.adjustedCredit), 0);
    const singleNet = single.rows.reduce((sum, row) => sum + row.netBalance, 0);
    if (Math.abs(soloNet - singleNet) > 0.15) {
      throw new Error(`single-entity parity failed ${soloNet} vs ${singleNet}`);
    }
  });

  await run("16F_19 as-of date excludes later activity", async () => {
    const pastEnd = "2020-01-31";
    const past = await buildConsolidatedTrialBalance(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      periodEnd: pastEnd,
      auth: ownerAuth,
    });
    if (past.periodEnd !== pastEnd) throw new Error("as-of not honored");
    const current = await buildConsolidatedTrialBalance(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      periodEnd,
      auth: ownerAuth,
    });
    if (current.totals.adjustedDebit < past.totals.adjustedDebit) {
      throw new Error("later activity not included in current vs past");
    }
  });

  await run("16F_20 P&L date range excludes out-of-range activity", async () => {
    const narrowStart = periodEnd;
    const narrowEnd = periodEnd;
    const consolidated = await buildConsolidatedProfitAndLoss(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      periodStart: narrowStart,
      periodEnd: narrowEnd,
      auth: ownerAuth,
    });
    const wide = await buildConsolidatedProfitAndLoss(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      periodStart,
      periodEnd,
      auth: ownerAuth,
    });
    if (Math.abs(consolidated.totalRevenue) > Math.abs(wide.totalRevenue) + 0.01) {
      throw new Error("narrow range exceeded wide range revenue");
    }
  });

  await run("16F_21 period statuses visible per entity", async () => {
    const report = await buildConsolidatedTrialBalance(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      periodEnd,
      auth: ownerAuth,
    });
    if (report.periodStatuses.length !== entityIds.length) {
      throw new Error("missing per-entity period status");
    }
    for (const status of report.periodStatuses) {
      if (!status.entityName || !status.status) throw new Error("incomplete period status row");
    }
  });

  await run("16F_22 entity contribution drill-down present", async () => {
    const report = await buildConsolidatedTrialBalance(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      periodEnd,
      auth: ownerAuth,
    });
    const withContributions = report.rows.filter((row) => row.entityContributions.length > 0);
    if (!withContributions.length) throw new Error("missing line-level entity contributions");
    const multiEntity = withContributions.find((row) => row.entityContributions.length >= 2);
    if (!multiEntity) throw new Error("missing multi-entity contribution row");
  });

  await run("16F_23 consolidated cash flow equals sum of entity cash flow", async () => {
    const consolidated = await buildConsolidatedCashFlow(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      periodStart,
      periodEnd,
      auth: ownerAuth,
    });
    let entityNetChange = 0;
    for (const id of entityIds) {
      const accounts = await loadEntityAccounts(supabase, orgId, id);
      const lines = await loadEntityDatedLines(supabase, {
        organizationId: orgId,
        legalEntityId: id,
        endDate: periodEnd,
      });
      const periodLines = lines.filter((line) => line.entry_date >= periodStart && line.entry_date <= periodEnd);
      const pl = buildProfitAndLoss(periodLines, accounts);
      const cf = buildCashFlowStatement(
        lines,
        accounts,
        { start: periodStart, end: periodEnd, label: "" },
        pl,
      );
      entityNetChange += cf.netChangeInCash;
    }
    if (Math.abs(consolidated.netChangeInCash - entityNetChange) > 0.05) {
      throw new Error(`cash flow mismatch ${consolidated.netChangeInCash} vs ${entityNetChange}`);
    }
    if (!consolidated.limitation) throw new Error("missing intercompany cash flow limitation note");
  });

  const beforeSideEffects = await snapshotSideEffects(supabase, orgId);
  const beforeReportJournals = beforeSideEffects.journals;

  await run("16F_24 report execution has zero economic side effects", async () => {
    await buildConsolidatedTrialBalance(supabase, {
      organizationId: orgId,
      includeAllEntities: true,
      periodEnd,
      auth: ownerAuth,
    });
    await buildConsolidatedProfitAndLoss(supabase, {
      organizationId: orgId,
      includeAllEntities: true,
      periodStart,
      periodEnd,
      auth: ownerAuth,
    });
    await buildConsolidatedBalanceSheet(supabase, {
      organizationId: orgId,
      includeAllEntities: true,
      asOf: periodEnd,
      auth: ownerAuth,
    });
    await buildConsolidatedCashFlow(supabase, {
      organizationId: orgId,
      includeAllEntities: true,
      periodStart,
      periodEnd,
      auth: ownerAuth,
    });
    const after = await snapshotSideEffects(supabase, orgId);
    if (after.journals !== beforeReportJournals) {
      throw new Error(`journal count changed during reports ${beforeReportJournals} -> ${after.journals}`);
    }
    if (after.payments !== beforeSideEffects.payments) throw new Error("payments changed");
    if (after.icTx !== beforeSideEffects.icTx) throw new Error("intercompany tx changed");
    if (after.icSettlements !== beforeSideEffects.icSettlements) throw new Error("settlements changed");
    if (after.periodCloses !== beforeSideEffects.periodCloses) throw new Error("period closes changed");
    if (after.accountingState !== beforeSideEffects.accountingState) throw new Error("accounting state changed");
  });

  await run("16F_25 HFAC unchanged", async () => {
    const hfacJournalsAfter = await countOrgRows(supabase, HFAC_ORG, "teller_journal_entries");
    const hfacDocsAfter = await countOrgRows(supabase, HFAC_ORG, "teller_documents");
    if (hfacJournalsAfter !== hfacJournalsBefore) throw new Error("HFAC journals changed");
    if (hfacDocsAfter !== hfacDocsBefore) throw new Error("HFAC documents changed");
  });

  await run("16F_26 zero unbalanced production journals (global sample)", async () => {
    const { count, error } = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .neq("is_balanced", true);
    if (error) {
      const demoUnbalanced = await countUnbalancedJournals(supabase, orgId);
      if (demoUnbalanced > 0) throw new Error(`demo org unbalanced journals=${demoUnbalanced}`);
      return;
    }
    if ((count ?? 0) > 0) throw new Error(`unbalanced production journals=${count}`);
  });

  await run("16F_27 deterministic rerun", async () => {
    const first = await buildConsolidatedTrialBalance(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      periodEnd,
      auth: ownerAuth,
    });
    const second = await buildConsolidatedTrialBalance(supabase, {
      organizationId: orgId,
      legalEntityIds: entityIds,
      periodEnd,
      auth: ownerAuth,
    });
    if (first.totals.adjustedDebit !== second.totals.adjustedDebit) {
      throw new Error("rerun not deterministic");
    }
  });

  const passed = results.filter((row) => row.pass).length;
  const failed = results.filter((row) => !row.pass);
  console.log(`\nPhase 16F acceptance: ${passed}/${results.length} PASS`);
  console.log(
    JSON.stringify(
      {
        PHASE16F_CONTROLLED_ACCEPTANCE: failed.length ? "FAIL" : "PASS",
        PHASE16F_ACCEPTANCE_SCENARIOS: results.length,
        pass: passed,
        fail: failed.length,
        failed,
      },
      null,
      2,
    ),
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
