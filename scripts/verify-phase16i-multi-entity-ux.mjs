#!/usr/bin/env node
/** Static Phase 16I multi-entity UX verification — no DB writes. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const issues = [];

function assertFile(relPath) {
  if (!existsSync(join(root, relPath))) issues.push(`Missing file: ${relPath}`);
}

function read(relPath) {
  return readFileSync(join(root, relPath), "utf8");
}

const requiredFiles = [
  "src/lib/legal-entity/ux.ts",
  "src/lib/legal-entity/companies-overview.ts",
  "src/components/legal-entity/CompanyContextHeader.tsx",
  "src/components/legal-entity/FinancialReportScopeHeader.tsx",
  "src/app/app/companies/page.tsx",
  "src/app/app/accounting/workspace/page.tsx",
  "src/lib/accounting/phase16i.test.ts",
  "scripts/controlled-phase16i-ux-acceptance.ts",
];

for (const file of requiredFiles) assertFile(file);

const ux = read("src/lib/legal-entity/ux.ts");
if (!ux.includes("companyBooksLabel")) issues.push("companyBooksLabel missing");
if (!ux.includes("closeReadinessUserMessage")) issues.push("closeReadinessUserMessage missing");
if (/legal_entity_id|organization_id/.test(ux) && !/ENTITY_CONTROL_USER_MESSAGES/.test(ux)) {
  issues.push("ux.ts should not expose raw IDs to owners");
}

const switcher = read("src/components/legal-entity/EntitySwitcher.tsx");
if (!/companiesOverview/.test(switcher)) issues.push("Entity switcher missing All Companies link");
if (!/reportsConsolidated/.test(switcher)) issues.push("Entity switcher missing consolidated link");

const shell = read("src/components/AppShell.tsx");
if (!/key=\{activeLegalEntity/.test(shell)) {
  issues.push("AppShell must remount main on entity switch");
}

const companies = read("src/app/app/companies/page.tsx");
if (!/Your books are currently set up for one company/.test(companies)) {
  issues.push("Single-entity empty state missing on All Companies page");
}

const dashboard = read("src/app/app/page.tsx");
if (!/legal_entity_id/.test(dashboard)) issues.push("Dashboard not entity-scoped");
if (!/CompanyContextHeader/.test(dashboard)) issues.push("Dashboard missing company context");

const reports = read("src/app/app/reports/page.tsx");
if (!/legalEntityId/.test(reports)) issues.push("Reports page not entity-scoped");
if (!/Company reports/.test(reports)) issues.push("Reports page should label company scope");

const reportEngine = read("src/lib/accounting/report-engine.ts");
if (!/ReportEngineOptions/.test(reportEngine)) issues.push("Report engine missing entity options");

console.log(
  JSON.stringify(
    {
      PHASE16I_MULTI_ENTITY_UX_VERIFY: issues.length ? "FAIL" : "PASS",
      OWNER_FACING_ENTITY_TERMINOLOGY: issues.length ? "FAIL" : "PASS",
      GLOBAL_COMPANY_SWITCHER: issues.length ? "FAIL" : "PASS",
      ALL_COMPANIES_POSTING_CONTEXT: false,
      ENTITY_CONTEXT_VISIBILITY: issues.length ? "FAIL" : "PASS",
      NEW_MIGRATION_REQUIRED: false,
      MANUAL_MIGRATION_FILE: null,
      issues,
      migrationsAutoApplied: false,
      sqlPatchesAutoApplied: false,
    },
    null,
    2,
  ),
);

process.exit(issues.length ? 1 : 0);
