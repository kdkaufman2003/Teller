/**
 * Phase 17F controlled UX acceptance (~45 checks).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { navItemsForMode } from "../src/lib/ux/navigation";
import { mapUserFacingError } from "../src/lib/ux/user-errors";
import { resolvePresentationMode } from "../src/lib/ux/presentation-mode";
import { presentLabel } from "../src/lib/accounting/presentation-mode";

type Result = { name: string; pass: boolean; detail?: string };
const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function pass(name: string, ok: boolean, detail?: string): Result {
  return { name, pass: ok, detail };
}

function runSuite(): Result[] {
  const r: Result[] = [];
  const audit = read("docs/PHASE-17F-UX-AUDIT.md");
  const appShell = read("src/components/AppShell.tsx");
  const invoices = read("src/app/app/invoices/page.tsx");
  const companies = read("src/app/app/companies/page.tsx");
  const jobs = read("src/app/app/jobs/page.tsx");
  const reportEngine = read("src/lib/accounting/report-engine.ts");

  r.push(pass("ux_audit_doc", existsSync(join(ROOT, "docs/PHASE-17F-UX-AUDIT.md"))));
  r.push(pass("owner_mode_defined", audit.includes("OWNER_MODE")));
  r.push(pass("accountant_mode_defined", audit.includes("ACCOUNTANT_MODE")));
  r.push(pass("mode_switching", audit.includes("MODE_SWITCHING_MODEL")));
  r.push(pass("navigation_model", audit.includes("NAVIGATION_MODEL")));

  r.push(pass("presentation_toggle", appShell.includes("PresentationModeToggle")));
  r.push(pass("nav_items_for_mode", appShell.includes("navItemsForMode")));
  r.push(pass("owner_nav_simpler", navItemsForMode("owner", [], {}).length < navItemsForMode("accountant", [], {}).length));

  r.push(pass("presentation_mode_api", existsSync(join(ROOT, "src/app/api/ux/presentation-mode/route.ts"))));
  r.push(pass("empty_state_component", existsSync(join(ROOT, "src/components/ui/EmptyState.tsx"))));
  r.push(pass("inline_alert_component", existsSync(join(ROOT, "src/components/ui/InlineAlert.tsx"))));
  r.push(pass("user_errors_module", existsSync(join(ROOT, "src/lib/ux/user-errors.ts"))));

  r.push(pass("invoice_remaining_column", invoices.includes("Remaining")));
  r.push(pass("invoice_empty_state", invoices.includes("EmptyState")));
  r.push(pass("money_in_heading", invoices.includes("Money in")));

  r.push(pass("all_companies_view_only", companies.includes("View only")));
  r.push(pass("jobs_entity_context", jobs.includes("CompanyContextHeader")));
  r.push(pass("jobs_multi_entity_note", jobs.includes("organization-wide")));

  r.push(pass("aging_authoritative", reportEngine.includes("batchAuthoritativeDocumentRemaining")));
  r.push(pass("aging_no_zero_hack", !reportEngine.includes("amount_paid: 0,\n    party_id: null")));

  r.push(pass("period_closed_error", mapUserFacingError("PERIOD_CLOSED").includes("closed")));
  r.push(pass("state_changed_error", mapUserFacingError("ACCOUNTING_STATE_CHANGED").includes("Refresh")));
  r.push(pass("idempotency_error", mapUserFacingError("IDEMPOTENCY_CONFLICT").includes("already recorded")));

  r.push(pass("owner_terminology", presentLabel("owner", "Accounts Receivable") === "Customers owe you"));
  r.push(pass("accountant_terminology", presentLabel("accountant", "Accounts Receivable") === "Accounts Receivable"));

  r.push(pass("cookie_mode_resolve", resolvePresentationMode({ role: "admin", cookieMode: "owner" }) === "owner"));
  r.push(pass("phase17f_tests", existsSync(join(ROOT, "src/lib/ux/phase17f.test.ts"))));
  r.push(pass("production_verify_script", existsSync(join(ROOT, "scripts/verify-phase17f-production.mjs"))));

  r.push(pass("no_db_patch", !existsSync(join(ROOT, "supabase/patches/055_phase17f_ux_support.sql"))));
  r.push(pass("17e_ready_intact", existsSync(join(ROOT, "src/app/api/ready/route.ts"))));
  r.push(pass("17e_ops_intact", existsSync(join(ROOT, "src/app/api/ops/status/route.ts"))));

  r.push(pass("dashboard_collected_fix", read("src/app/app/page.tsx").includes("batchAuthoritativeDocumentRemaining")));
  r.push(pass("presentation_mode_lib", existsSync(join(ROOT, "src/lib/ux/presentation-mode.ts"))));
  r.push(pass("status_labels", existsSync(join(ROOT, "src/lib/ux/status-labels.ts"))));

  r.push(pass("accountant_workspace_route", read("src/lib/routes.ts").includes("accountingWorkspace")));
  r.push(pass("reports_route", read("src/lib/routes.ts").includes("reports:")));
  r.push(pass("banking_route", read("src/lib/routes.ts").includes("banking:")));

  r.push(pass("hfac_not_ux_fixture", !audit.includes("HFAC production org for UX")));
  r.push(pass("accounting_engine_shared", audit.includes("ACCOUNTING_ENGINE_SHARED = true")));

  return r;
}

function main() {
  const all = runSuite();
  const failed = all.filter((row) => !row.pass);
  console.log(`Phase 17F UX acceptance: ${all.length - failed.length}/${all.length} PASS`);
  for (const row of all) {
    console.log(`${row.pass ? "PASS" : "FAIL"} ${row.name}${row.detail ? ` (${row.detail})` : ""}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main();
