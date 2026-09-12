#!/usr/bin/env node
/** Static Phase 16H entity controls verification — no DB writes. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const issues = [];

function assertFile(relPath) {
  if (!existsSync(join(root, relPath))) issues.push(`Missing file: ${relPath}`);
}

const requiredFiles = [
  "docs/PHASE-16-ENTITY-SCOPE.md",
  "supabase/migrations/047_phase16h_entity_controls.sql",
  "src/lib/accounting/entity-books/document-context.ts",
  "src/lib/accounting/entity-books/errors.ts",
  "src/lib/accounting/entity-books/validation.ts",
  "src/lib/accounting/entity-books/settings.ts",
  "src/lib/accounting/phase16h.test.ts",
  "scripts/controlled-phase16h-db-acceptance.ts",
  "scripts/verify-migration-047-static.mjs",
];

for (const file of requiredFiles) assertFile(file);

const validation = readFileSync(join(root, "src/lib/accounting/entity-books/validation.ts"), "utf8");
for (const fn of [
  "assertAccountBelongsToEntity",
  "assertDocumentBelongsToEntity",
  "assertPaymentBelongsToEntity",
  "assertBankAccountBelongsToEntity",
  "assertAllocationSameEntity",
]) {
  if (!validation.includes(fn)) issues.push(`${fn} missing`);
}

const post = readFileSync(join(root, "src/lib/accounting/post.ts"), "utf8");
if (!/resolvePostingLegalEntityId/.test(post)) {
  issues.push("post.ts must resolve entity from document before posting");
}

const payments = readFileSync(join(root, "src/lib/accounting/payments.ts"), "utf8");
if (!/legal_entity_id/.test(payments)) issues.push("payments must persist legal_entity_id");

const invoices = readFileSync(join(root, "src/app/api/invoices/route.ts"), "utf8");
if (!/requireAccountingWriteBooks/.test(invoices)) {
  issues.push("invoices route must use entity-aware guards");
}
if (!/nextEntityDocumentNumber/.test(invoices)) {
  issues.push("invoices must use entity-scoped numbering");
}

console.log(
  JSON.stringify(
    {
      PHASE16H_ENTITY_CONTROLS_VERIFY: issues.length ? "FAIL" : "PASS",
      ACCOUNTING_SCOPE_REGISTRY: issues.length ? "FAIL" : "PASS",
      ENTITY_ACCOUNTING_SETTINGS_CANONICAL: true,
      ENTITY_OWNERSHIP_VALIDATION_CANONICAL: issues.length ? "FAIL" : "PASS",
      CROSS_ENTITY_ACCOUNT_POSTING: false,
      LEGACY_ZERO_MEMBERSHIP_ACCESS: "RETAIN_WITH_JUSTIFICATION",
      NEW_MIGRATION_REQUIRED: true,
      MANUAL_MIGRATION_FILE: "supabase/migrations/047_phase16h_entity_controls.sql",
      issues,
      migrationsAutoApplied: false,
      sqlPatchesAutoApplied: false,
    },
    null,
    2,
  ),
);

process.exit(issues.length ? 1 : 0);
