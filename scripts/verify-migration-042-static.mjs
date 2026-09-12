#!/usr/bin/env node
/** Static verification for migration 042 — no production writes. */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const M042 = resolve(process.cwd(), "supabase/migrations/042_phase16c_entity_books.sql");

function main() {
  const issues = [];
  if (!existsSync(M042)) {
    console.log(JSON.stringify({ MIGRATION_042_STATIC_VERIFY: "FAIL", issues: ["Missing 042 migration file"] }, null, 2));
    process.exit(1);
  }

  const sql = readFileSync(M042, "utf8");
  const checks = {
    entity_accounting_settings_table: /create table if not exists public\.teller_entity_accounting_settings/i.test(sql),
    accounts_legal_entity_id: /alter table public\.teller_accounts[\s\S]*legal_entity_id/i.test(sql),
    accounts_entity_code_unique: /teller_accounts_entity_code_uidx/i.test(sql),
    journals_legal_entity_id: /alter table public\.teller_journal_entries[\s\S]*legal_entity_id/i.test(sql),
    journal_entity_immutable: /teller_journal_entries_entity_immutable/i.test(sql),
    documents_legal_entity_id: /alter table public\.teller_documents[\s\S]*legal_entity_id/i.test(sql),
    payments_legal_entity_id: /alter table public\.teller_payments[\s\S]*legal_entity_id/i.test(sql),
    bank_accounts_legal_entity_id: /alter table public\.teller_bank_accounts[\s\S]*legal_entity_id/i.test(sql),
    period_closes_legal_entity_id: /alter table public\.teller_period_closes[\s\S]*legal_entity_id/i.test(sql),
    cross_entity_account_guard: /teller_assert_accounts_match_entity/i.test(sql),
    bank_gl_entity_guard: /teller_assert_bank_gl_entity_match/i.test(sql),
    post_journal_entity_param: /teller_post_journal\(\s*\n\s*p_organization_id uuid,\s*\n\s*p_legal_entity_id uuid/i.test(sql),
    books_closed_through_entity: /teller_books_closed_through\(\s*\n\s*p_org uuid,\s*\n\s*p_legal_entity_id uuid/i.test(sql),
    close_period_entity_param: /teller_close_accounting_period\(\s*\n\s*p_organization_id uuid,\s*\n\s*p_legal_entity_id uuid/i.test(sql),
    default_entity_backfill: /teller_default_legal_entity_id/i.test(sql),
    no_intercompany_impl: !/create table public\.teller_.*intercompany|due_to|due_from|elimination_entries/i.test(sql),
    no_journal_backfill_insert: !/insert into public\.teller_journal_entries\s*\([^)]+\)\s*select/i.test(sql),
  };

  for (const [key, ok] of Object.entries(checks)) {
    if (!ok) issues.push(`042 static missing/failed: ${key}`);
  }

  const pass = issues.length === 0;
  console.log(
    JSON.stringify(
      {
        MIGRATION_042_STATIC_VERIFY: pass ? "PASS" : "FAIL",
        migrationFile: "supabase/migrations/042_phase16c_entity_books.sql",
        checks,
        issues,
        manualApplyRequired: true,
        automaticMigrationApplication: false,
      },
      null,
      2,
    ),
  );
  process.exit(pass ? 0 : 1);
}

main();
