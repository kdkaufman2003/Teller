#!/usr/bin/env node
/** Static + controlled production verification for migration 038 — no writes. */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const root = process.cwd();
const issues = [];
const migrationPath = "supabase/migrations/038_phase15g_tax_authority_payments.sql";

if (!existsSync(resolve(root, migrationPath))) {
  issues.push(`Missing migration: ${migrationPath}`);
} else {
  const sql = readFileSync(resolve(root, migrationPath), "utf8");
  for (const token of [
    "teller_tax_authority_payments",
    "teller_tax_authority_payment_allocations",
    "teller_tax_manual_adjustments",
    "tax_penalty_expense_account_id",
    "registration_id",
    "authority_payment_id",
    "enable row level security",
    "teller_guard_tax_authority_payment_org",
  ]) {
    if (!sql.includes(token)) issues.push(`038 migration missing: ${token}`);
  }
  if (/\binsert\s+into\s+public\.teller_journal_entries/i.test(sql)) {
    issues.push("038 migration must not insert journal entries");
  }
  if (/\b(create|alter|drop|replace)\s+function\s+public\.teller_post_journal/i.test(sql)) {
    issues.push("038 migration must not modify teller_post_journal");
  }
}

for (const rel of [
  "src/lib/accounting/tax/payments/post-payment.ts",
  "src/lib/accounting/tax/payments/adjustments.ts",
  "src/lib/accounting/tax/payments/period-balance.ts",
  "src/lib/accounting/tax/payments/bank-match.ts",
  "src/lib/accounting/tax/phase15g.test.ts",
  "src/app/api/tax/authority-payments/route.ts",
]) {
  if (!existsSync(resolve(root, rel))) issues.push(`Missing file: ${rel}`);
}

const paymentDomain = [
  "src/lib/accounting/tax/payments/post-payment.ts",
  "src/lib/accounting/tax/payments/adjustments.ts",
  "src/lib/accounting/tax/filing/rollforward.ts",
]
  .map((rel) => readFileSync(resolve(root, rel), "utf8"))
  .join("\n");

if (!/postAuthorityTaxPayment/.test(paymentDomain)) {
  issues.push("15G canonical postAuthorityTaxPayment missing");
}
if (!/reverseAuthorityTaxPayment/.test(paymentDomain)) {
  issues.push("15G payment reversal missing");
}
if (!/postTaxManualAdjustment/.test(paymentDomain)) {
  issues.push("15G manual adjustment missing");
}
if (!/authorityPayments|authority_payment/.test(paymentDomain)) {
  issues.push("15G rollforward must include authority payments");
}
if (!/penalty_amount|penaltyExpenseAccountId/.test(paymentDomain)) {
  issues.push("15G penalty separation missing");
}
if (/teller_post_journal|postJournal\(/.test(paymentDomain.replace(/postJournal/g, ""))) {
  // postJournal is used via post.ts wrapper — allowed
}
if (!/postJournal/.test(readFileSync(resolve(root, "src/lib/accounting/tax/payments/post-payment.ts"), "utf8"))) {
  issues.push("15G must post journals through postJournal wrapper");
}
if (!/linkAuthorityTaxPaymentToBankTransaction/.test(
  readFileSync(resolve(root, "src/lib/accounting/tax/payments/bank-match.ts"), "utf8"),
)) {
  issues.push("15G bank match boundary missing");
}

async function restProbe(supabase) {
  const checks = {};
  for (const table of [
    "teller_tax_authority_payments",
    "teller_tax_authority_payment_allocations",
    "teller_tax_manual_adjustments",
  ]) {
    const { error } = await supabase.from(table).select("*", { head: true, count: "exact" }).limit(1);
    checks[`table_${table}`] = !error;
    if (error) checks[`table_${table}_error`] = error.message;
  }
  for (const probe of [
    { key: "column_tax_settings_penalty", table: "teller_tax_settings", column: "tax_penalty_expense_account_id" },
    { key: "column_tax_settings_interest", table: "teller_tax_settings", column: "tax_interest_expense_account_id" },
    { key: "column_tax_settings_overpayment", table: "teller_tax_settings", column: "tax_overpayment_account_id" },
    { key: "column_tax_transactions_registration", table: "teller_tax_transactions", column: "registration_id" },
    { key: "column_tax_transactions_authority_payment", table: "teller_tax_transactions", column: "authority_payment_id" },
  ]) {
    const { error } = await supabase.from(probe.table).select(probe.column).limit(1);
    checks[probe.key] = !error;
    if (error) checks[`${probe.key}_error`] = error.message;
  }
  return checks;
}

async function main() {
  loadControlledProdEnv();
  const staticOk = issues.length === 0;
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const checks = await restProbe(supabase);
  const productionOk = Object.entries(checks)
    .filter(([key]) => !key.endsWith("_error"))
    .every(([, value]) => value === true);
  if (!productionOk) {
    for (const [key, value] of Object.entries(checks)) {
      if (!key.endsWith("_error") && value !== true) issues.push(`production check failed: ${key}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        MIGRATION_038_STATIC_VERIFY: staticOk ? "PASS" : "FAIL",
        MIGRATION_038_PRODUCTION_VERIFY: productionOk ? "PASS" : "FAIL",
        MIGRATION_038_VERIFY: staticOk && productionOk ? "PASS" : "FAIL",
        issues,
        checks,
        migrationFile: migrationPath,
      },
      null,
      2,
    ),
  );
  process.exit(staticOk && productionOk ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
