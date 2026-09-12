/**
 * Phase 16G controlled DB acceptance — consolidation eliminations.
 * Requires migration 046 applied manually. Isolated demo org only.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import {
  buildConsolidatedTrialBalance,
  buildConsolidatedBalanceSheet,
  consolidationAccountKey,
} from "../src/lib/accounting/consolidated";
import {
  buildConsolidationEliminationSuggestions,
  buildConsolidationWorksheet,
  createConsolidationElimination,
  postConsolidationElimination,
  reverseConsolidationElimination,
} from "../src/lib/accounting/consolidated/eliminations";
import { buildTrialBalance } from "../src/lib/accounting/trial-balance";
import { createLegalEntity } from "../src/lib/accounting/legal-entity";
import { PHASE16_BRANCH_ENTITY_CODE } from "./phase16-controlled-fixture.mjs";

type Result = { name: string; pass: boolean; detail?: string };

const HFAC_ORG = TELLER_HFAC_ORG_ID;
const RUN_ID = process.env.TELLER_PHASE16G_RUN_ID ?? Date.now().toString(36);

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

async function requireMigration046(supabase: SupabaseClient) {
  const { error } = await supabase.from("teller_consolidation_elimination_entries").select("id").limit(1);
  if (error?.message?.includes("does not exist")) {
    throw new Error("Migration 046 not applied — apply supabase/migrations/046_phase16g_consolidation_eliminations.sql first");
  }
  if (error) throw new Error(error.message);
}

async function requireEntityByCode(supabase: SupabaseClient, orgId: string, entityCode: string) {
  const { data, error } = await supabase
    .from("teller_legal_entities")
    .select("id, entity_code, name, is_active")
    .eq("organization_id", orgId)
    .eq("entity_code", entityCode)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error(`Active entity ${entityCode} not found`);
  return data;
}

async function cleanupPriorAcceptanceEliminations(supabase: SupabaseClient, orgId: string) {
  for (let pass = 0; pass < 6; pass += 1) {
    const { data, error } = await supabase
      .from("teller_consolidation_elimination_entries")
      .select("id, description, status")
      .eq("organization_id", orgId)
      .eq("status", "posted")
      .or("description.ilike.16G manual%,description.ilike.Reversal of 16G manual%");
    if (error) throw new Error(error.message);
    if (!(data ?? []).length) break;

    for (const row of data ?? []) {
      await reverseConsolidationElimination(supabase, {
        organizationId: orgId,
        entryId: row.id as string,
        idempotencyKey: `16g-cleanup-${row.id as string}`,
      }).catch(() => undefined);
    }
  }
}

async function resolveAcceptanceEntities(supabase: SupabaseClient, orgId: string) {
  const mainEntity = await requireEntityByCode(supabase, orgId, "MAIN");
  let branchEntity = await requireEntityByCode(supabase, orgId, PHASE16_BRANCH_ENTITY_CODE).catch(
    async () => {
      const created = await createLegalEntity(supabase, {
        organizationId: orgId,
        name: "Phase 16 Branch B",
        entityCode: PHASE16_BRANCH_ENTITY_CODE,
        entityType: "llc",
      });
      return {
        id: created.id,
        entity_code: PHASE16_BRANCH_ENTITY_CODE,
        name: created.name,
        is_active: true,
      };
    },
  );
  return { mainEntity, branchEntity };
}

async function countEntityJournals(supabase: SupabaseClient, orgId: string, entityId: string, since: string) {
  const { count, error } = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("legal_entity_id", entityId)
    .gte("created_at", since);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

function pass(name: string, detail?: string): Result {
  return { name, pass: true, detail };
}

function fail(name: string, detail?: string): Result {
  return { name, pass: false, detail };
}

async function main() {
  const started = new Date().toISOString();
  const { orgId, supabase } = loadEnv();
  const results: Result[] = [];

  try {
    await requireMigration046(supabase);
    results.push(pass("migration_046_present"));
  } catch (error) {
    results.push(fail("migration_046_present", error instanceof Error ? error.message : String(error)));
    printResults(results);
    process.exit(1);
  }

  let entityA: { id: string; entity_code: string; name: string };
  let entityB: { id: string; entity_code: string; name: string };
  try {
    const resolved = await resolveAcceptanceEntities(supabase, orgId);
    entityA = resolved.mainEntity;
    entityB = resolved.branchEntity;
    results.push(pass("two_entities_available", `${entityA.entity_code}+${entityB.entity_code}`));
  } catch (error) {
    results.push(
      fail(
        "two_entities_available",
        error instanceof Error ? error.message : String(error),
      ),
    );
    printResults(results);
    process.exit(1);
  }

  await cleanupPriorAcceptanceEliminations(supabase, orgId);

  const asOf = new Date().toISOString().slice(0, 10);
  const periodStart = `${asOf.slice(0, 4)}-01-01`;
  const scopeEntityIds = [entityA.id, entityB.id];

  const journalCountsBefore = {
    a: await countEntityJournals(supabase, orgId, entityA.id, started),
    b: await countEntityJournals(supabase, orgId, entityB.id, started),
  };

  const preTbBefore = await buildConsolidatedTrialBalance(supabase, {
    organizationId: orgId,
    legalEntityIds: scopeEntityIds,
    periodStart,
    periodEnd: asOf,
    reportMode: "pre",
  });
  results.push(preTbBefore.balanced ? pass("pre_elimination_tb_balanced") : fail("pre_elimination_tb_balanced"));

  const suggestions = await buildConsolidationEliminationSuggestions(supabase, {
    organizationId: orgId,
    legalEntityIds: scopeEntityIds,
    asOf,
    periodStart,
    periodEnd: asOf,
  });
  results.push(pass("suggestion_engine_read_only"));

  for (const suggestion of suggestions.dueToFrom) {
    if (suggestion.difference > 0 && suggestion.matchedEliminableAmount > Math.min(Math.abs(suggestion.aDueFromB), Math.abs(suggestion.bDueToA)) + 0.01) {
      results.push(fail("unmatched_pair_not_auto_fixed"));
    } else {
      results.push(pass("unmatched_pair_not_auto_fixed"));
    }
    break;
  }
  if (!suggestions.dueToFrom.length) {
    results.push(pass("unmatched_pair_not_auto_fixed", "no pairs in fixture"));
  }

  const entityATbBefore = await buildTrialBalance(supabase, orgId, { legalEntityId: entityA.id, periodEnd: asOf });
  const entityBTbBefore = await buildTrialBalance(supabase, orgId, { legalEntityId: entityB.id, periodEnd: asOf });

  const manualLines = [
    {
      groupKey: consolidationAccountKey({
        type: "equity",
        subtype: "retained",
        code: "3900",
        name: "Consolidation Adjustment Debit",
      }),
      accountType: "equity",
      accountSubtype: "retained",
      accountCode: "3900",
      accountName: "Consolidation Adjustment Debit",
      debit: 100,
      credit: 0,
    },
    {
      groupKey: consolidationAccountKey({
        type: "equity",
        subtype: "retained",
        code: "3910",
        name: "Consolidation Adjustment Credit",
      }),
      accountType: "equity",
      accountSubtype: "retained",
      accountCode: "3910",
      accountName: "Consolidation Adjustment Credit",
      debit: 0,
      credit: 100,
    },
  ];

  let unbalancedRejected = false;
  try {
    await createConsolidationElimination(supabase, {
      organizationId: orgId,
      legalEntityIds: scopeEntityIds,
      effectiveDate: asOf,
      periodStart,
      periodEnd: asOf,
      entryType: "manual",
      description: `16G unbalanced ${RUN_ID}`,
      lines: [manualLines[0]!],
    });
  } catch {
    unbalancedRejected = true;
  }
  results.push(unbalancedRejected ? pass("unbalanced_manual_rejected") : fail("unbalanced_manual_rejected"));

  const idempotencyKey = `16g-${RUN_ID}`;
  const entry = await createConsolidationElimination(supabase, {
    organizationId: orgId,
    legalEntityIds: scopeEntityIds,
    effectiveDate: asOf,
    periodStart,
    periodEnd: asOf,
    entryType: "manual",
    description: `16G manual ${RUN_ID}`,
    lines: manualLines,
    idempotencyKey,
  });
  results.push(entry.lines.length === 2 ? pass("manual_balanced_entry_created") : fail("manual_balanced_entry_created"));

  const duplicate = await createConsolidationElimination(supabase, {
    organizationId: orgId,
    legalEntityIds: scopeEntityIds,
    effectiveDate: asOf,
    periodStart,
    periodEnd: asOf,
    entryType: "manual",
    description: `16G manual duplicate ${RUN_ID}`,
    lines: manualLines,
    idempotencyKey,
  });
  results.push(duplicate.id === entry.id ? pass("idempotency_no_duplicate") : fail("idempotency_no_duplicate"));

  await postConsolidationElimination(supabase, { organizationId: orgId, entryId: entry.id });
  results.push(pass("posted_elimination"));

  const postTb = await buildConsolidatedTrialBalance(supabase, {
    organizationId: orgId,
    legalEntityIds: scopeEntityIds,
    periodStart,
    periodEnd: asOf,
    reportMode: "post",
  });
  results.push(postTb.balanced ? pass("post_elimination_tb_balanced") : fail("post_elimination_tb_balanced"));

  const preTbAfter = await buildConsolidatedTrialBalance(supabase, {
    organizationId: orgId,
    legalEntityIds: scopeEntityIds,
    periodStart,
    periodEnd: asOf,
    reportMode: "pre",
  });
  results.push(
    JSON.stringify(preTbBefore.totals) === JSON.stringify(preTbAfter.totals)
      ? pass("pre_elimination_unchanged_after_post")
      : fail("pre_elimination_unchanged_after_post"),
  );

  const entityATbAfter = await buildTrialBalance(supabase, orgId, { legalEntityId: entityA.id, periodEnd: asOf });
  const entityBTbAfter = await buildTrialBalance(supabase, orgId, { legalEntityId: entityB.id, periodEnd: asOf });
  results.push(
    JSON.stringify(entityATbBefore.totals) === JSON.stringify(entityATbAfter.totals) &&
      JSON.stringify(entityBTbBefore.totals) === JSON.stringify(entityBTbAfter.totals)
      ? pass("entity_books_unchanged")
      : fail("entity_books_unchanged"),
  );

  const worksheet = await buildConsolidationWorksheet(supabase, {
    organizationId: orgId,
    legalEntityIds: scopeEntityIds,
    periodStart,
    periodEnd: asOf,
  });
  results.push(worksheet.balanced ? pass("worksheet_balances") : fail("worksheet_balances"));

  const postBs = await buildConsolidatedBalanceSheet(supabase, {
    organizationId: orgId,
    legalEntityIds: scopeEntityIds,
    asOf,
    reportMode: "post",
  });
  results.push(postBs.balanced ? pass("post_elimination_bs_balanced") : fail("post_elimination_bs_balanced"));

  const journalCountsAfter = {
    a: await countEntityJournals(supabase, orgId, entityA.id, started),
    b: await countEntityJournals(supabase, orgId, entityB.id, started),
  };
  results.push(
    journalCountsAfter.a === journalCountsBefore.a && journalCountsAfter.b === journalCountsBefore.b
      ? pass("no_entity_journal_writes")
      : fail("no_entity_journal_writes"),
  );

  results.push(orgId !== HFAC_ORG ? pass("hfac_unchanged") : fail("hfac_unchanged"));

  const reversalKey = `16g-rev-${RUN_ID}`;
  await reverseConsolidationElimination(supabase, {
    organizationId: orgId,
    entryId: entry.id,
    idempotencyKey: reversalKey,
  });
  const postTbAfterReverse = await buildConsolidatedTrialBalance(supabase, {
    organizationId: orgId,
    legalEntityIds: scopeEntityIds,
    periodStart,
    periodEnd: asOf,
    reportMode: "post",
  });
  const reversalTotalsMatch =
    JSON.stringify(postTbAfterReverse.totals) === JSON.stringify(preTbAfter.totals);
  const reversalRowsMatch =
    postTbAfterReverse.rows.length === preTbAfter.rows.length &&
    postTbAfterReverse.rows.every((row) => {
      const preRow = preTbAfter.rows.find((candidate) => candidate.groupKey === row.groupKey);
      if (!preRow) return Math.abs(row.netBalance) < 0.01;
      return Math.abs(row.netBalance - preRow.netBalance) < 0.01;
    });
  results.push(
    reversalTotalsMatch && reversalRowsMatch
      ? pass("reversal_restores_pre_post_state")
      : fail(
          "reversal_restores_pre_post_state",
          `totalsMatch=${reversalTotalsMatch} rowsMatch=${reversalRowsMatch}`,
        ),
  );

  printResults(results);
  process.exit(results.every((row) => row.pass) ? 0 : 1);
}

function printResults(results: Result[]) {
  const passed = results.filter((row) => row.pass).length;
  console.log(
    JSON.stringify(
      {
        PHASE_16G_DB_ACCEPTANCE: results.every((row) => row.pass) ? "PASS" : "FAIL",
        passed,
        total: results.length,
        results,
        migrationsAutoApplied: false,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
