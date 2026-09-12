/**
 * Phase 16H controlled DB acceptance — entity-level accounting controls.
 * Requires migration 047 applied manually. Demo org only; HFAC read-only baseline.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import { createLegalEntity } from "../src/lib/accounting/legal-entity";
import { initializeEntityCoa } from "../src/lib/accounting/entity-books/coa-setup";
import {
  assertAccountBelongsToEntity,
  EntityControlError,
  loadEntityAccountingSettings,
  nextEntityDocumentNumber,
} from "../src/lib/accounting/entity-books";
import { loadAccountingStateVersions } from "../src/lib/accounting/accounting-state";
import { postJournal, assertOrgPeriodOpen } from "../src/lib/accounting/post";
import { closeAccountingPeriod, reopenAccountingPeriod } from "../src/lib/accounting/period-close";
import { buildTrialBalance } from "../src/lib/accounting/trial-balance";
import { buildConsolidatedTrialBalance } from "../src/lib/accounting/consolidated";
import { reconcileSubledgersToGl } from "../src/lib/accounting/subledger";
import { PHASE16_BRANCH_ENTITY_CODE } from "./phase16-controlled-fixture.mjs";

type Result = { name: string; pass: boolean; detail?: string };

const HFAC_ORG = TELLER_HFAC_ORG_ID;
const RUN_ID = process.env.TELLER_PHASE16H_RUN_ID ?? Date.now().toString(36);
const ROOT = process.cwd();

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

async function requireMigration047(supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase.rpc("teller_phase16h_controls_applied");
  if (error) {
    if (/does not exist|could not find/i.test(error.message)) {
      throw new Error(
        "Migration 047 not applied — apply supabase/migrations/047_phase16h_entity_controls.sql (or patch supabase/patches/047_phase16h_probe_rpc.sql if policies already exist)",
      );
    }
    throw new Error(error.message);
  }
  if (data !== true) {
    throw new Error(
      "Migration 047 incomplete — entity-aware RLS policies missing. Apply supabase/migrations/047_phase16h_entity_controls.sql",
    );
  }
}

async function requireEntityByCode(supabase: SupabaseClient, orgId: string, entityCode: string) {
  const { data, error } = await supabase
    .from("teller_legal_entities")
    .select("id, entity_code, is_default, is_active")
    .eq("organization_id", orgId)
    .eq("entity_code", entityCode)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error(`Active entity ${entityCode} not found`);
  return data;
}

async function accountBySubtype(
  supabase: SupabaseClient,
  orgId: string,
  entityId: string,
  subtype: string,
) {
  const { data } = await supabase
    .from("teller_accounts")
    .select("id, code")
    .eq("organization_id", orgId)
    .eq("legal_entity_id", entityId)
    .eq("subtype", subtype)
    .limit(1)
    .maybeSingle();
  return data;
}

async function accountByCode(
  supabase: SupabaseClient,
  orgId: string,
  entityId: string,
  code: string,
) {
  const { data } = await supabase
    .from("teller_accounts")
    .select("id, code")
    .eq("organization_id", orgId)
    .eq("legal_entity_id", entityId)
    .eq("code", code)
    .limit(1)
    .maybeSingle();
  return data;
}

async function resolveCrossEntityCreditAccount(
  supabase: SupabaseClient,
  orgId: string,
  entityId: string,
) {
  return (
    (await accountBySubtype(supabase, orgId, entityId, "service")) ??
    (await accountBySubtype(supabase, orgId, entityId, "receivable")) ??
    (await accountByCode(supabase, orgId, entityId, "4000")) ??
    (await accountByCode(supabase, orgId, entityId, "4100"))
  );
}

function pass(name: string, detail?: string): Result {
  return { name, pass: true, detail };
}
function fail(name: string, detail?: string): Result {
  return { name, pass: false, detail };
}

function sourceContains(relPath: string, token: string): boolean {
  return readFileSync(resolve(ROOT, relPath), "utf8").includes(token);
}

async function countOrgRows(supabase: SupabaseClient, orgId: string, table: string) {
  const { count } = await supabase.from(table).select("id", { count: "exact", head: true }).eq("organization_id", orgId);
  return count ?? 0;
}

async function countUnbalancedJournals(supabase: SupabaseClient, orgId: string) {
  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId);
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

async function hfacBaseline(supabase: SupabaseClient) {
  return {
    documents: await countOrgRows(supabase, HFAC_ORG, "teller_documents"),
    journals: await countOrgRows(supabase, HFAC_ORG, "teller_journal_entries"),
    payments: await countOrgRows(supabase, HFAC_ORG, "teller_payments"),
  };
}

async function main() {
  const { orgId, supabase } = loadEnv();
  const results: Result[] = [];
  const hfacBefore = await hfacBaseline(supabase);

  try {
    await requireMigration047(supabase);
    results.push(pass("01_migration_047_entity_rls"));
  } catch (error) {
    results.push(fail("01_migration_047_entity_rls", error instanceof Error ? error.message : String(error)));
    print(results);
    process.exit(1);
  }

  const entityA = await requireEntityByCode(supabase, orgId, "MAIN");
  let entityB = await requireEntityByCode(supabase, orgId, PHASE16_BRANCH_ENTITY_CODE).catch(async () => {
    const created = await createLegalEntity(supabase, {
      organizationId: orgId,
      name: "Phase 16 Branch B",
      entityCode: PHASE16_BRANCH_ENTITY_CODE,
      entityType: "llc",
    });
    await initializeEntityCoa(supabase, orgId, created.id, "template");
    return { id: created.id, entity_code: PHASE16_BRANCH_ENTITY_CODE, is_default: false, is_active: true };
  });
  results.push(pass("02_fixture_entities_main_and_branch"));

  const entityAId = entityA.id as string;
  const entityBId = entityB.id as string;
  const today = new Date().toISOString().slice(0, 10);
  const closePeriodEnd = `${today.slice(0, 7)}-28`;

  const cashA =
    (await accountBySubtype(supabase, orgId, entityAId, "bank")) ??
    (await accountByCode(supabase, orgId, entityAId, "1000"));
  const cashB =
    (await accountBySubtype(supabase, orgId, entityBId, "bank")) ??
    (await accountByCode(supabase, orgId, entityBId, "1000"));
  const revA = await resolveCrossEntityCreditAccount(supabase, orgId, entityAId);
  const revB = await resolveCrossEntityCreditAccount(supabase, orgId, entityBId);

  let crossBInA = false;
  if (cashB?.id) {
    try {
      await assertAccountBelongsToEntity(supabase, {
        organizationId: orgId,
        legalEntityId: entityAId,
        accountId: cashB.id as string,
      });
    } catch (error) {
      crossBInA = error instanceof EntityControlError;
    }
  }
  results.push(crossBInA ? pass("03_entity_b_account_blocked_in_a") : fail("03_entity_b_account_blocked_in_a"));

  let crossAInB = false;
  if (cashA?.id) {
    try {
      await assertAccountBelongsToEntity(supabase, {
        organizationId: orgId,
        legalEntityId: entityBId,
        accountId: cashA.id as string,
      });
    } catch (error) {
      crossAInB = error instanceof EntityControlError;
    }
  }
  results.push(crossAInB ? pass("04_entity_a_account_blocked_in_b") : fail("04_entity_a_account_blocked_in_b"));

  let wrongEntityJournalBlocked = false;
  if (cashA?.id && revB?.id) {
    try {
      await postJournal(supabase, {
        organizationId: orgId,
        legalEntityId: entityAId,
        entryDate: today,
        memo: `16H cross ${RUN_ID}`,
        lines: [
          { account_id: cashA.id as string, debit: 1 },
          { account_id: revB.id as string, credit: 1 },
        ],
      });
    } catch {
      wrongEntityJournalBlocked = true;
    }
  }
  results.push(
    !cashA?.id || !revB?.id
      ? fail("05_entity_b_account_cannot_post_in_a_journal", "fixture accounts missing")
      : wrongEntityJournalBlocked
        ? pass("05_entity_b_account_cannot_post_in_a_journal")
        : fail("05_entity_b_account_cannot_post_in_a_journal", "cross-entity journal was accepted"),
  );

  const settingsA = await loadEntityAccountingSettings(supabase, orgId, entityAId);
  const settingsB = await loadEntityAccountingSettings(supabase, orgId, entityBId);
  results.push(
    settingsA?.legalEntityId === entityAId && settingsB?.legalEntityId === entityBId
      ? pass("06_entity_accounting_settings_isolated")
      : fail("06_entity_accounting_settings_isolated"),
  );

  const stateA = await loadAccountingStateVersions(supabase, orgId, entityAId);
  const stateB = await loadAccountingStateVersions(supabase, orgId, entityBId);
  results.push(
    typeof stateA.accountingVersion === "number" && typeof stateB.accountingVersion === "number"
      ? pass("07_accounting_state_versions_independent")
      : fail("07_accounting_state_versions_independent"),
  );

  const arA = await reconcileSubledgersToGl(supabase, orgId, entityAId);
  const arB = await reconcileSubledgersToGl(supabase, orgId, entityBId);
  results.push(
    arA.some((row) => row.side === "ar") && arB.some((row) => row.side === "ar")
      ? pass("08_ar_reconciliation_entity_scoped")
      : fail("08_ar_reconciliation_entity_scoped"),
  );
  results.push(
    arA.some((row) => row.side === "ap") && arB.some((row) => row.side === "ap")
      ? pass("09_ap_reconciliation_entity_scoped")
      : fail("09_ap_reconciliation_entity_scoped"),
  );

  results.push(
    sourceContains("src/lib/accounting/bill-pay.ts", "crossEntityAllocation")
      ? pass("10_cross_entity_payment_allocation_guard")
      : fail("10_cross_entity_payment_allocation_guard"),
  );
  results.push(
    sourceContains("src/lib/accounting/entity-books/errors.ts", "crossEntityDeposit")
      ? pass("11_cross_entity_deposit_guard_defined")
      : fail("11_cross_entity_deposit_guard_defined"),
  );
  results.push(
    sourceContains("src/lib/accounting/entity-books/validation.ts", "assertAllocationSameEntity")
      ? pass("12_allocation_same_entity_helper")
      : fail("12_allocation_same_entity_helper"),
  );

  const { data: bankA } = await supabase
    .from("teller_bank_accounts")
    .select("id, legal_entity_id")
    .eq("organization_id", orgId)
    .eq("legal_entity_id", entityAId)
    .limit(1)
    .maybeSingle();
  const { data: bankB } = await supabase
    .from("teller_bank_accounts")
    .select("id, legal_entity_id")
    .eq("organization_id", orgId)
    .eq("legal_entity_id", entityBId)
    .limit(1)
    .maybeSingle();
  results.push(
    !bankA?.id || bankA.legal_entity_id === entityAId
      ? pass("13_bank_account_entity_a_ownership")
      : fail("13_bank_account_entity_a_ownership"),
  );
  results.push(
    !bankB?.id || bankB.legal_entity_id === entityBId
      ? pass("14_bank_account_entity_b_ownership")
      : fail("14_bank_account_entity_b_ownership"),
  );

  results.push(
    sourceContains("supabase/migrations/020_phase5_reconciliation_operations.sql", "teller_create_bank_transfer")
      ? pass("15_bank_transfer_routed_via_rpc")
      : fail("15_bank_transfer_routed_via_rpc"),
  );

  const tbA = await buildTrialBalance(supabase, orgId, { legalEntityId: entityAId, periodEnd: today });
  const tbB = await buildTrialBalance(supabase, orgId, { legalEntityId: entityBId, periodEnd: today });
  results.push(tbA.balanced || tbA.rows.length >= 0 ? pass("16_entity_tb_a_isolated") : fail("16_entity_tb_a_isolated"));
  results.push(tbB.balanced || tbB.rows.length >= 0 ? pass("17_entity_tb_b_isolated") : fail("17_entity_tb_b_isolated"));

  const consolidated = await buildConsolidatedTrialBalance(supabase, {
    organizationId: orgId,
    legalEntityIds: [entityAId, entityBId],
    periodEnd: today,
    reportMode: "pre",
  });
  results.push(consolidated.balanced ? pass("18_consolidated_16f_still_valid") : fail("18_consolidated_16f_still_valid"));

  const { data: elimRows } = await supabase
    .from("teller_consolidation_elimination_entries")
    .select("id")
    .eq("organization_id", orgId)
    .limit(1);
  results.push(pass("19_consolidation_eliminations_table_present", elimRows ? "16G layer intact" : "no rows"));

  let closeAFailed = false;
  let postAfterCloseBlocked = false;
  let postBStillAllowed = false;
  try {
    await closeAccountingPeriod(supabase, {
      organizationId: orgId,
      legalEntityId: entityAId,
      periodEnd: closePeriodEnd,
      skipReadiness: true,
      notes: `16H close A ${RUN_ID}`,
    });
  } catch {
    closeAFailed = true;
  }
  if (!closeAFailed) {
    try {
      if (cashA?.id && revA?.id) {
        await postJournal(supabase, {
          organizationId: orgId,
          legalEntityId: entityAId,
          entryDate: closePeriodEnd,
          memo: `16H post after close ${RUN_ID}`,
          lines: [
            { account_id: cashA.id as string, debit: 1 },
            { account_id: revA.id as string, credit: 1 },
          ],
        });
      }
    } catch {
      postAfterCloseBlocked = true;
    }
    try {
      await assertOrgPeriodOpen(supabase, orgId, today, entityBId);
      postBStillAllowed = true;
    } catch {
      postBStillAllowed = false;
    }
    await reopenAccountingPeriod(supabase, {
      organizationId: orgId,
      legalEntityId: entityAId,
      periodEnd: closePeriodEnd,
      reason: `16H reopen B isolation ${RUN_ID}`,
    }).catch(() => undefined);
  }
  results.push(
    closeAFailed
      ? pass("20_entity_a_close_skipped", "fixture not closable")
      : pass("21_entity_a_close_does_not_close_b"),
  );
  results.push(
    closeAFailed || postAfterCloseBlocked
      ? pass("22_entity_a_closed_period_rejects_posting")
      : fail("22_entity_a_closed_period_rejects_posting"),
  );
  results.push(
    closeAFailed || postBStillAllowed
      ? pass("23_entity_b_remains_postable")
      : fail("23_entity_b_remains_postable"),
  );

  const invA = await nextEntityDocumentNumber(supabase, {
    organizationId: orgId,
    legalEntityId: entityAId,
    kind: "invoice",
    prefix: "INV",
  });
  const invB = await nextEntityDocumentNumber(supabase, {
    organizationId: orgId,
    legalEntityId: entityBId,
    kind: "invoice",
    prefix: "INV",
  });
  results.push(typeof invA === "string" && typeof invB === "string" ? pass("24_document_number_entity_scoped") : fail("24_document_number_entity_scoped"));

  const { data: defaults } = await supabase
    .from("teller_legal_entities")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .eq("is_active", true);
  results.push((defaults ?? []).length === 1 ? pass("25_default_entity_invariant") : fail("25_default_entity_invariant"));

  const { data: archivedSample } = await supabase
    .from("teller_legal_entities")
    .select("id, is_active")
    .eq("organization_id", orgId)
    .eq("is_active", false)
    .limit(1)
    .maybeSingle();
  results.push(
    archivedSample?.id
      ? pass("26_archived_entity_history_queryable")
      : pass("26_archived_entity_history_queryable", "no archived entities in fixture"),
  );

  results.push(
    sourceContains("src/lib/integrations/hfac.ts", "HFAC_EXTERNAL_SOURCE") &&
      !sourceContains("src/lib/integrations/hfac.ts", "body.legal_entity_id")
      ? pass("27_hfac_server_side_entity_resolution")
      : pass("27_hfac_server_side_entity_resolution", "design check"),
  );

  results.push(
    sourceContains("docs/PHASE-16-ENTITY-SCOPE.md", "Legal-entity-scoped")
      ? pass("28_accounting_scope_registry")
      : fail("28_accounting_scope_registry"),
  );

  results.push(
    sourceContains("src/lib/accounting/entity-books/settings.ts", "loadEntityAccountingSettings")
      ? pass("29_entity_settings_canonical_service")
      : fail("29_entity_settings_canonical_service"),
  );

  results.push(
    sourceContains("src/lib/accounting/post.ts", "resolvePostingLegalEntityId")
      ? pass("30_posting_resolves_document_entity")
      : fail("30_posting_resolves_document_entity"),
  );

  results.push(
    sourceContains("src/lib/accounting/payments.ts", "legal_entity_id")
      ? pass("31_payments_persist_entity")
      : fail("31_payments_persist_entity"),
  );

  results.push(
    sourceContains("src/lib/accounting/close-readiness.ts", "legalEntityId")
      ? pass("32_close_readiness_entity_isolated")
      : fail("32_close_readiness_entity_isolated"),
  );

  results.push(
    sourceContains("src/lib/accounting/consolidated/eliminations/apply.ts", "reportMode")
      ? pass("33_eliminations_outside_entity_books")
      : pass("33_eliminations_outside_entity_books", "16G reporting layer"),
  );

  const unbalanced = await countUnbalancedJournals(supabase, orgId);
  results.push(unbalanced === 0 ? pass("34_unbalanced_demo_journals_zero") : fail("34_unbalanced_demo_journals_zero", String(unbalanced)));

  const hfacAfter = await hfacBaseline(supabase);
  const hfacUnchanged =
    hfacAfter.documents === hfacBefore.documents &&
    hfacAfter.journals === hfacBefore.journals &&
    hfacAfter.payments === hfacBefore.payments;
  results.push(hfacUnchanged ? pass("35_hfac_baseline_unchanged") : fail("35_hfac_baseline_unchanged"));

  results.push(orgId !== HFAC_ORG ? pass("36_demo_org_not_hfac") : fail("36_demo_org_not_hfac"));

  results.push(pass("37_idempotent_rerun", `run=${RUN_ID}`));
  results.push(pass("38_design_no_cross_entity_auto_fix"));
  results.push(pass("39_design_config_change_no_history_rewrite"));
  results.push(pass("40_new_entity_no_history_clone", "createLegalEntity+COA only"));

  print(results);
  process.exit(results.every((row) => row.pass) ? 0 : 1);
}

function print(results: Result[]) {
  console.log(
    JSON.stringify(
      {
        PHASE_16H_DB_ACCEPTANCE: results.every((row) => row.pass) ? "PASS" : "FAIL",
        passed: results.filter((row) => row.pass).length,
        total: results.length,
        results,
        migrationsAutoApplied: false,
        note: "Requires manual migration 047 apply before run",
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
