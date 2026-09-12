#!/usr/bin/env node
/** Static Phase 16A multi-entity verification — no DB writes. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const issues = [];

function assertFile(relPath, label) {
  if (!existsSync(join(root, relPath))) issues.push(`Missing file: ${relPath} (${label})`);
}

function assertSql(relPath, tokens, forbidden, label) {
  const path = join(root, relPath);
  if (!existsSync(path)) {
    issues.push(`Missing SQL: ${relPath}`);
    return;
  }
  const sql = readFileSync(path, "utf8");
  for (const token of tokens) {
    if (!sql.includes(token)) issues.push(`${label} missing: ${token}`);
  }
  for (const token of forbidden) {
    if (sql.includes(token)) issues.push(`${label} forbidden: ${token}`);
  }
}

assertSql(
  "supabase/migrations/040_phase16a_legal_entity_foundation.sql",
  [
    "teller_legal_entities",
    "organization_id",
    "entity_code",
    "is_default",
    "is_active",
    "teller_legal_entities_one_default_per_org",
    "teller_seed_default_legal_entity",
    "enable row level security",
    "teller_is_org_member",
    "teller_complete_setup",
    "legal_entity_id",
  ],
  [
    "legal_entity_id uuid not null references public.teller_journal_entries",
    "alter table public.teller_journal_entries add column",
    "teller_consolidation_groups",
    "intercompany",
  ],
  "040 migration",
);

if (/alter table public\.teller_journal_entries[\s\S]*legal_entity_id/i.test(
  readFileSync(join(root, "supabase/migrations/040_phase16a_legal_entity_foundation.sql"), "utf8"),
)) {
  issues.push("040 migration must not add legal_entity_id to journals in 16A");
}

if (existsSync(join(root, "src/lib/integrations/hfac-org.ts"))) {
  const hfacOrg = readFileSync(join(root, "src/lib/integrations/hfac-org.ts"), "utf8");
  if (/requestedLegalEntityId|client.*legal_entity/i.test(hfacOrg)) {
    issues.push("HFAC must not accept client-controlled legal entity");
  }
}

assertSql(
  "supabase/migrations/041_phase16b_entity_access.sql",
  [
    "teller_legal_entity_memberships",
    "active_legal_entity_id",
    "teller_can_access_legal_entity",
    "teller_set_default_legal_entity",
    "teller members read accessible legal entities",
    "enable row level security",
  ],
  [
    "alter table public.teller_journal_entries add column",
    "intercompany",
    "teller_consolidation_groups",
  ],
  "041 migration",
);

const requiredFiles = [
  "docs/PHASE-16-ARCHITECTURE.md",
  "docs/PHASE-16-IMPLEMENTATION.md",
  "src/lib/accounting/legal-entity/types.ts",
  "src/lib/accounting/legal-entity/resolver.ts",
  "src/lib/accounting/legal-entity/context.ts",
  "src/lib/accounting/legal-entity/service.ts",
  "src/lib/accounting/legal-entity/access.ts",
  "src/lib/accounting/legal-entity/active-context.ts",
  "src/lib/accounting/phase16a.test.ts",
  "src/lib/accounting/phase16b.test.ts",
  "src/lib/accounting/phase16c.test.ts",
  "supabase/migrations/042_phase16c_entity_books.sql",
  "src/app/api/legal-entities/route.ts",
  "src/app/api/legal-entities/active/route.ts",
  "src/app/app/settings/entities/page.tsx",
  "src/components/legal-entity/EntitySwitcher.tsx",
  "scripts/controlled-phase16a-db-acceptance.ts",
  "scripts/controlled-phase16b-db-acceptance.ts",
  "supabase/migrations/041_phase16b_entity_access.sql",
];

for (const file of requiredFiles) assertFile(file, "Phase 16A");

const resolver = readFileSync(join(root, "src/lib/accounting/legal-entity/resolver.ts"), "utf8");
if (!/resolveDefaultLegalEntity/.test(resolver)) issues.push("resolveDefaultLegalEntity missing");
if (!/resolveAuthorizedLegalEntity/.test(resolver)) issues.push("resolveAuthorizedLegalEntity missing");

const context = readFileSync(join(root, "src/lib/accounting/legal-entity/context.ts"), "utf8");
if (!/AccountingContext/.test(context)) issues.push("AccountingContext type missing");

const access = readFileSync(join(root, "src/lib/accounting/legal-entity/access.ts"), "utf8");
if (!/canAccessLegalEntity/.test(access)) issues.push("canAccessLegalEntity missing");

const activeContext = readFileSync(join(root, "src/lib/accounting/legal-entity/active-context.ts"), "utf8");
if (!/resolveActiveLegalEntityContext/.test(activeContext)) {
  issues.push("resolveActiveLegalEntityContext missing");
}

const api = readFileSync(join(root, "src/lib/api.ts"), "utf8");
if (!/requireEntityBooks/.test(api)) issues.push("requireEntityBooks missing");

const postTs = existsSync(join(root, "src/lib/accounting/post.ts"))
  ? readFileSync(join(root, "src/lib/accounting/post.ts"), "utf8")
  : "";
if (!/p_legal_entity_id|resolveLegalEntityId/.test(postTs)) {
  issues.push("post.ts must resolve and pass legal_entity_id to teller_post_journal");
}
if (!/requireAccountingBooks|requireEntityBooks/.test(readFileSync(join(root, "src/lib/api.ts"), "utf8"))) {
  issues.push("requireAccountingBooks / requireEntityBooks missing");
}
if (!existsSync(join(root, "scripts/controlled-phase16c-db-acceptance.ts"))) {
  issues.push("Missing controlled-phase16c-db-acceptance.ts");
}
if (!existsSync(join(root, "src/lib/accounting/entity-books/coa-setup.ts"))) {
  issues.push("Missing entity-books COA setup");
}

console.log(
  JSON.stringify(
    {
      PHASE16_MULTI_ENTITY_VERIFY: issues.length ? "FAIL" : "PASS",
      issues,
      manualMigrationRequired: true,
      migrationFiles: [
        "supabase/migrations/040_phase16a_legal_entity_foundation.sql",
        "supabase/migrations/041_phase16b_entity_access.sql",
        "supabase/migrations/042_phase16c_entity_books.sql",
      ],
      phase16cPrepared: existsSync(join(root, "supabase/migrations/042_phase16c_entity_books.sql")),
      automaticMigrationApplication: false,
      consolidationImplemented: false,
      intercompanyImplemented: false,
      hfacModified: false,
    },
    null,
    2,
  ),
);

process.exit(issues.length ? 1 : 0);
