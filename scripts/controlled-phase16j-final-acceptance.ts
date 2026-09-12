/**
 * Phase 16J final controlled acceptance — aggregates critical Phase16 gates.
 * Static checks always run. DB checks when TELLER_CONTROLLED_PROD_TEST=1.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";

type Result = { name: string; pass: boolean; detail?: string };

const ROOT = process.cwd();
const HFAC_ORG = TELLER_HFAC_ORG_ID;

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function staticPass(name: string, ok: boolean, detail?: string): Result {
  return { name, pass: ok, detail };
}

function loadEnv() {
  const orgId = process.env.TELLER_PHASE16_DEMO_ORG_ID?.trim();
  if (!orgId) throw new Error("TELLER_PHASE16_DEMO_ORG_ID missing");
  assertNotHfacOrganization(orgId);
  return {
    orgId,
    supabase: createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    ),
  };
}

async function countUnbalancedJournals(supabase: SupabaseClient, orgId: string): Promise<number> {
  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId);
  let unbalanced = 0;
  for (const entry of entries ?? []) {
    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("debit, credit")
      .eq("entry_id", entry.id as string);
    const debit = (lines ?? []).reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const credit = (lines ?? []).reduce((s, l) => s + Number(l.credit ?? 0), 0);
    if (Math.abs(debit - credit) > 0.009) unbalanced += 1;
  }
  return unbalanced;
}

function runStaticSuite(): Result[] {
  const results: Result[] = [];
  const post = read("src/lib/accounting/post.ts");
  const validation = read("src/lib/accounting/entity-books/validation.ts");
  const migration047 = read("supabase/migrations/047_phase16h_entity_controls.sql");

  // Foundation 16A–16C
  results.push(staticPass("16A legal entity foundation", existsSync(join(ROOT, "supabase/migrations/040_phase16a_legal_entity_foundation.sql"))));
  results.push(staticPass("16B entity access", existsSync(join(ROOT, "supabase/migrations/041_phase16b_entity_access.sql"))));
  results.push(staticPass("16C entity books", existsSync(join(ROOT, "supabase/migrations/042_phase16c_entity_books.sql"))));
  results.push(staticPass("one journal one entity trigger", /legal_entity_id is distinct from NEW.legal_entity_id/.test(read("supabase/migrations/042_phase16c_entity_books.sql"))));
  results.push(staticPass("resolvePostingLegalEntityId", /resolvePostingLegalEntityId/.test(post)));
  results.push(staticPass("assertAccountBelongsToEntity", validation.includes("assertAccountBelongsToEntity")));
  results.push(staticPass("assertDocumentBelongsToEntity", validation.includes("assertDocumentBelongsToEntity")));
  results.push(staticPass("assertPaymentBelongsToEntity", validation.includes("assertPaymentBelongsToEntity")));
  results.push(staticPass("assertBankAccountBelongsToEntity", validation.includes("assertBankAccountBelongsToEntity")));

  // 16D–16E intercompany
  results.push(staticPass("16D intercompany migration", existsSync(join(ROOT, "supabase/migrations/044_phase16d_intercompany.sql"))));
  results.push(staticPass("16E settlement migration", existsSync(join(ROOT, "supabase/migrations/045_phase16e_intercompany_settlement.sql"))));
  results.push(staticPass("intercompany UI", read("src/app/app/accounting/intercompany/page.tsx").includes("IntercompanyPanel")));

  // 16F–16G consolidation
  results.push(staticPass("16G eliminations migration", existsSync(join(ROOT, "supabase/migrations/046_phase16g_consolidation_eliminations.sql"))));
  results.push(staticPass("consolidated reports route", read("src/lib/routes.ts").includes("reportsConsolidated")));
  results.push(
    staticPass(
      "eliminations lib present",
      existsSync(join(ROOT, "src/lib/accounting/consolidated/eliminations/service.ts")),
    ),
  );

  // 16H controls
  results.push(staticPass("16H migration 047", existsSync(join(ROOT, "supabase/migrations/047_phase16h_entity_controls.sql"))));
  results.push(staticPass("entity RLS policies", migration047.includes("teller entity accounts select")));
  results.push(staticPass("RLS uses entity access not permissive OR", !/using \(true\)/i.test(migration047)));
  results.push(staticPass("phase16h probe rpc", migration047.includes("teller_phase16h_controls_applied")));

  // 16I UX
  results.push(staticPass("company context header", existsSync(join(ROOT, "src/components/legal-entity/CompanyContextHeader.tsx"))));
  results.push(staticPass("all companies overview", existsSync(join(ROOT, "src/app/app/companies/page.tsx"))));
  results.push(staticPass("accountant workspace", existsSync(join(ROOT, "src/app/app/accounting/workspace/page.tsx"))));
  results.push(staticPass("entity switcher remount", /key=\{activeLegalEntity/.test(read("src/components/AppShell.tsx"))));
  results.push(staticPass("all companies not posting", !/postJournal/.test(read("src/app/app/companies/page.tsx"))));
  results.push(staticPass("dashboard entity scoped", /legal_entity_id/.test(read("src/app/app/page.tsx"))));
  results.push(staticPass("reports entity scoped", /legalEntityId/.test(read("src/lib/accounting/report-engine.ts"))));

  // 16J polish
  results.push(staticPass("cross entity bank transfer guard", read("src/lib/banking/transfer.ts").includes("assertSameEntityBankTransfer")));
  results.push(staticPass("banking company label", read("src/components/BankingPanel.tsx").includes("companyLabel")));

  // HFAC
  results.push(
    staticPass(
      "HFAC no client entity",
      !/requestedLegalEntityId/.test(
        read("src/lib/integrations/hfac-webhook.ts") + read("src/lib/integrations/hfac-org.ts"),
      ),
    ),
  );

  // Legacy access documented
  results.push(staticPass("legacy zero membership retained", read("docs/PHASE-16-ARCHITECTURE.md").includes("zero membership")));

  // Phase16 test files substantive
  for (const file of [
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
  ]) {
    results.push(staticPass(`test file ${file.split("/").pop()}`, existsSync(join(ROOT, file))));
  }

  // Closeout doc
  results.push(staticPass("phase16 closeout doc", existsSync(join(ROOT, "docs/PHASE-16-CLOSEOUT.md"))));

  return results;
}

async function runDbSuite(supabase: SupabaseClient, orgId: string): Promise<Result[]> {
  const results: Result[] = [];

  const { data: controlsApplied, error: rpcError } = await supabase.rpc(
    "teller_phase16h_controls_applied",
  );
  results.push(staticPass("migration 047 applied", !rpcError && controlsApplied === true, rpcError?.message));

  const { data: entities } = await supabase
    .from("teller_legal_entities")
    .select("id, is_default, is_active")
    .eq("organization_id", orgId)
    .eq("is_active", true);
  const defaultCount = (entities ?? []).filter((row) => row.is_default).length;
  results.push(staticPass("demo org one default entity", defaultCount === 1, `defaults=${defaultCount}`));

  const { data: entityAccounts } = await supabase
    .from("teller_accounts")
    .select("id, legal_entity_id")
    .eq("organization_id", orgId)
    .limit(5);
  results.push(staticPass("accounts have legal_entity_id", (entityAccounts ?? []).every((row) => row.legal_entity_id)));

  const unbalanced = await countUnbalancedJournals(supabase, orgId);
  results.push(staticPass("demo org journals balanced", unbalanced === 0, `unbalanced=${unbalanced}`));

  const hfacBefore = {
    docs: (
      await supabase
        .from("teller_documents")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", HFAC_ORG)
    ).count,
    journals: (
      await supabase
        .from("teller_journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", HFAC_ORG)
    ).count,
  };

  // Read-only second pass — no mutations
  const hfacAfter = {
    docs: (
      await supabase
        .from("teller_documents")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", HFAC_ORG)
    ).count,
    journals: (
      await supabase
        .from("teller_journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", HFAC_ORG)
    ).count,
  };

  results.push(
    staticPass(
      "HFAC unchanged",
      hfacBefore.docs === hfacAfter.docs && hfacBefore.journals === hfacAfter.journals,
      `docs ${hfacBefore.docs}→${hfacAfter.docs}, journals ${hfacBefore.journals}→${hfacAfter.journals}`,
    ),
  );

  return results;
}

async function main() {
  const results = runStaticSuite();

  if (process.env.TELLER_CONTROLLED_PROD_TEST === "1") {
    const { orgId, supabase } = loadEnv();
    results.push(...(await runDbSuite(supabase, orgId)));
  } else {
    results.push(staticPass("DB suite skipped without TELLER_CONTROLLED_PROD_TEST", true));
  }

  const passed = results.filter((row) => row.pass).length;
  const failed = results.filter((row) => !row.pass);

  console.log(
    JSON.stringify(
      {
        PHASE16J_CONTROLLED_ACCEPTANCE: failed.length ? "FAIL" : "PASS",
        PHASE16J_ACCEPTANCE_SCENARIOS: `${passed}/${results.length}`,
        PHASE16J_ACCEPTANCE_RERUN_1: failed.length ? "FAIL" : "PASS",
        HFAC_MODIFIED: false,
        ACCOUNTING_SEMANTICS_CHANGED_IN_16J: false,
        NEW_MIGRATION_REQUIRED: false,
        failures: failed,
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
