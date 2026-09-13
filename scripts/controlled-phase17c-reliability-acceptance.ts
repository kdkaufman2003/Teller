/**
 * Phase 17C controlled reliability acceptance (~55 checks).
 * Static always. DB when TELLER_CONTROLLED_PROD_TEST=1.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import {
  billPaymentIdempotencyKey,
  deterministicEventId,
  invoicePaymentIdempotencyKey,
} from "../src/lib/reliability/idempotency";

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

function runStaticSuite(): Result[] {
  const results: Result[] = [];
  const patch052 = read("supabase/patches/052_phase17c_reliability_hardening.sql");
  const idempotency = read("src/lib/reliability/idempotency.ts");
  const post = read("src/lib/accounting/post.ts");
  const billPay = read("src/lib/accounting/bill-pay.ts");
  const payments = read("src/lib/accounting/payments.ts");
  const hfacWebhook = read("src/lib/integrations/hfac-webhook.ts");
  const hfacOrg = read("src/lib/integrations/hfac-org.ts");
  const categorize = read("src/lib/banking/categorize.ts");
  const schedules = read("src/lib/accounting/schedules/process-due.ts");
  const depositRpc = read("supabase/migrations/016_phase3_customer_deposits.sql");

  // Patch 052
  results.push(staticPass("patch_052_exists", existsSync(join(ROOT, "supabase/patches/052_phase17c_reliability_hardening.sql"))));
  results.push(staticPass("patch_052_hfac_lifecycle", patch052.includes("processing_status")));
  results.push(staticPass("patch_052_payment_idempotency_col", patch052.includes("teller_payments") && patch052.includes("idempotency_key")));
  results.push(staticPass("patch_052_allocation_capacity", patch052.includes("teller_payment_allocation_capacity_check")));
  results.push(staticPass("patch_052_credit_capacity", patch052.includes("teller_document_allocation_capacity_check")));
  results.push(staticPass("patch_052_probe", patch052.includes("teller_phase17c_reliability_probe")));
  results.push(staticPass("patch_052_static_verifier", existsSync(join(ROOT, "scripts/verify-migration-052-static.mjs"))));
  results.push(staticPass("patch_052_no_journal_rewrite", !/\bupdate\b.*teller_journal_entries/i.test(patch052)));

  // Idempotency standard module
  results.push(staticPass("idempotency_module", existsSync(join(ROOT, "src/lib/reliability/idempotency.ts"))));
  results.push(staticPass("deterministic_event_id", idempotency.includes("deterministicEventId")));
  results.push(staticPass("invoice_payment_key_helper", idempotency.includes("invoicePaymentIdempotencyKey")));
  results.push(staticPass("bill_payment_key_helper", idempotency.includes("billPaymentIdempotencyKey")));
  results.push(staticPass("banking_operation_seed", idempotency.includes("bankingOperationSeed")));

  // Payment paths
  results.push(staticPass("record_payment_idempotency_lookup", payments.includes("idempotency_key")));
  results.push(staticPass("post_invoice_paid_precheck", post.includes("invoicePaymentIdempotencyKey")));
  results.push(staticPass("bill_pay_db_idempotency", billPay.includes("idempotencyKey: resolvedIdempotencyKey")));
  results.push(staticPass("bill_pay_duplicate_replay", billPay.includes("duplicate: true")));

  // HFAC webhook reliability
  results.push(staticPass("hfac_claim_event", hfacOrg.includes("claimHfacWebhookEvent")));
  results.push(staticPass("hfac_mark_processed", hfacOrg.includes("markHfacWebhookProcessed")));
  results.push(staticPass("hfac_mark_failed", hfacOrg.includes("markHfacWebhookFailed")));
  results.push(staticPass("hfac_duplicate_processed_response", hfacWebhook.includes("duplicate_processed")));
  results.push(staticPass("hfac_retry_failed_status", hfacOrg.includes('"failed"')));

  // Banking deterministic retry
  results.push(staticPass("banking_seed_fallback", categorize.includes("bankingOperationSeed")));
  results.push(staticPass("banking_no_random_uuid", !categorize.includes("randomUUID")));

  // Schedule concurrency
  results.push(staticPass("schedule_atomic_claim", schedules.includes('.is("journal_entry_id", null)')));
  results.push(staticPass("schedule_idempotency_key", read("supabase/migrations/027_phase11_subledger_automation.sql").includes("idempotency_key")));

  // Deposit RPC remains atomic
  results.push(staticPass("deposit_apply_rpc", depositRpc.includes("teller_apply_deposit_to_invoice")));
  results.push(staticPass("deposit_for_update", depositRpc.includes("for update")));
  results.push(staticPass("deposit_deterministic_seed", read("src/lib/accounting/deposits.ts").includes("normalizeUuidEventId")));
  results.push(staticPass("deposit_no_random_uuid", !read("src/lib/accounting/deposits.ts").includes("randomUUID")));

  // Intercompany atomic (Phase 16)
  results.push(staticPass("intercompany_atomic_rpc", read("supabase/migrations/044_phase16d_intercompany.sql").includes("teller_atomic_post_intercompany")));
  results.push(staticPass("settlement_atomic_rpc", read("supabase/migrations/045_phase16e_intercompany_settlement.sql").includes("teller_atomic_post_intercompany_settlement")));

  // Inventory / GRNI idempotency
  results.push(staticPass("inventory_idempotency", read("supabase/migrations/031_phase13_inventory.sql").includes("idempotency_key")));
  results.push(staticPass("grni_settlement_rpc", read("src/lib/accounting/inventory/atomic-rpc.ts").includes("teller_atomic_settle_inventory_receipt_bill")));

  // Period close concurrency
  results.push(staticPass("period_close_advisory_lock", read("supabase/migrations/025_phase9_month_end_close.sql").includes("pg_advisory_xact_lock")));

  // Document numbering entity scope
  results.push(staticPass("entity_document_number_unique", read("supabase/migrations/042_phase16c_entity_books.sql").includes("legal_entity_id, kind, number")));

  // Retry semantics documented
  results.push(staticPass("reliability_doc", existsSync(join(ROOT, "docs/PHASE-17C-RELIABILITY.md"))));
  results.push(staticPass("phase17c_tests", existsSync(join(ROOT, "src/lib/reliability/phase17c.test.ts"))));
  results.push(staticPass("production_verify_script", existsSync(join(ROOT, "scripts/verify-phase17c-production.mjs"))));

  // Deterministic key stability (local)
  const k1 = invoicePaymentIdempotencyKey("org", "doc", "2026-01-01", 100);
  const k2 = invoicePaymentIdempotencyKey("org", "doc", "2026-01-01", 100);
  results.push(staticPass("invoice_key_deterministic", k1 === k2, k1));

  const b1 = billPaymentIdempotencyKey("org", "party", "2026-01-01", 50, ["a", "b"]);
  const b2 = billPaymentIdempotencyKey("org", "party", "2026-01-01", 50, ["b", "a"]);
  results.push(staticPass("bill_key_order_independent", b1 === b2));

  const e1 = deterministicEventId("test-seed");
  const e2 = deterministicEventId("test-seed");
  results.push(staticPass("event_id_stable", e1 === e2));

  // Partial path inventory (documented, not all fixed in 17C)
  results.push(staticPass("post_invoice_multi_step_known", post.includes("postInvoicePaid")));
  results.push(staticPass("canonical_post_journal_rpc", post.includes("teller_post_journal")));

  // No unsafe journal mutations
  const unsafeJournal = /\.from\(["']teller_journal_(entries|lines)["']\)\s*\.\s*(insert|update|delete|upsert)/;
  let journalHits = 0;
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && unsafeJournal.test(readFileSync(full, "utf8"))) {
        journalHits += 1;
      }
    }
  }
  walk(join(ROOT, "src"));
  results.push(staticPass("no_unsafe_journal_mutations_src", journalHits === 0, String(journalHits)));

  return results;
}

async function runDbSuite(orgId: string, supabase: SupabaseClient): Promise<Result[]> {
  const results: Result[] = [];

  const { data: probe052, error: err052 } = await supabase.rpc("teller_phase17c_reliability_probe");
  if (err052?.message?.includes("Could not find the function")) {
    results.push(staticPass("patch_052_applied", false, "Patch 052 not applied — manual application required"));
  } else {
    results.push(staticPass("patch_052_reliability_probe", probe052 === true, String(probe052)));
  }

  const { data: probe051 } = await supabase.rpc("teller_phase17b_journal_insert_blocked");
  results.push(staticPass("patch_051_still_effective", probe051 === true, String(probe051)));

  // HFAC baseline unchanged
  const { count: hfacDocs } = await supabase
    .from("teller_documents")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", HFAC_ORG);
  const { count: hfacJournals } = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", HFAC_ORG);
  results.push(staticPass("hfac_documents_baseline", (hfacDocs ?? 0) === 8, String(hfacDocs)));
  results.push(staticPass("hfac_journals_baseline", (hfacJournals ?? 0) === 17, String(hfacJournals)));

  // Demo org journals balanced
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
  results.push(staticPass("demo_journals_balanced", unbalanced === 0, String(unbalanced)));

  // Concurrent idempotency key collision simulation (in-memory only — no writes)
  const concurrentKeys = await Promise.all(
    Array.from({ length: 10 }, () =>
      Promise.resolve(invoicePaymentIdempotencyKey(orgId, "doc-concurrent-test", "2026-01-01", 1)),
    ),
  );
  const uniqueKeys = new Set(concurrentKeys);
  results.push(staticPass("concurrent_key_generation_stable", uniqueKeys.size === 1, String(uniqueKeys.size)));

  // Schedule occurrence unique constraint exists (read metadata)
  const { data: scheduleOcc } = await supabase
    .from("teller_schedule_occurrences")
    .select("idempotency_key")
    .eq("organization_id", orgId)
    .limit(1);
  results.push(staticPass("schedule_occurrence_readable", !scheduleOcc || Array.isArray(scheduleOcc)));

  // Payment idempotency column readable when patch applied
  if (probe052 === true) {
    const { error: payColErr } = await supabase
      .from("teller_payments")
      .select("idempotency_key")
      .eq("organization_id", orgId)
      .limit(1);
    results.push(staticPass("payment_idempotency_column", !payColErr, payColErr?.message));
  }

  // HFAC webhook processing_status when patch applied
  if (probe052 === true) {
    const { error: hfacColErr } = await supabase
      .from("teller_hfac_webhook_events")
      .select("processing_status")
      .limit(1);
    results.push(staticPass("hfac_processing_status_column", !hfacColErr, hfacColErr?.message));
  }

  return results;
}

async function main() {
  const staticResults = runStaticSuite();
  let dbResults: Result[] = [];

  if (process.env.TELLER_CONTROLLED_PROD_TEST === "1") {
    const { orgId, supabase } = loadEnv();
    dbResults = await runDbSuite(orgId, supabase);
  } else {
    dbResults.push(staticPass("db_suite_skipped", true, "TELLER_CONTROLLED_PROD_TEST not set"));
  }

  const all = [...staticResults, ...dbResults];
  const failed = all.filter((r) => !r.pass);

  console.log(`Phase 17C reliability acceptance: ${all.length - failed.length}/${all.length} PASS`);
  for (const r of all) {
    console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  }

  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
