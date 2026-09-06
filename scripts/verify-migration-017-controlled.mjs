#!/usr/bin/env node
/** Verify migration 017 schema + HFAC economics unchanged vs pre-migration snapshot. */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";
const PHASE4_RPCS = [
  "teller_reverse_payment",
  "teller_reverse_deposit_application",
  "teller_reverse_document_allocation",
  "teller_refund_customer_deposit",
  "teller_refund_customer_credit",
  "teller_write_off_invoice",
];

async function rpcExists(supabase, name) {
  const { error } = await supabase.rpc(name, {});
  if (!error) return true;
  const message = error.message.toLowerCase();
  return !message.includes("does not exist") && !message.includes("could not find the function");
}

async function countOrg(supabase, table, orgId) {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function main() {
  loadControlledProdEnv();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const checks = [];

  const { error: writeOffError } = await supabase
    .from("teller_write_offs")
    .select("id", { count: "exact", head: true });
  checks.push({
    name: "teller_write_offs",
    pass: !writeOffError,
    detail: writeOffError?.message ?? "exists",
  });

  for (const col of ["reversal_of_allocation_id", "reversed_by_allocation_id", "reversal_event_id"]) {
    const { error } = await supabase.from("teller_payment_allocations").select(col).limit(0);
    checks.push({ name: `payment_allocations.${col}`, pass: !error, detail: error?.message ?? "ok" });
  }

  for (const rpc of PHASE4_RPCS) {
    const exists = await rpcExists(supabase, rpc);
    checks.push({ name: `rpc ${rpc}`, pass: exists, detail: exists ? "present" : "missing" });
  }

  const removed = await rpcExists(supabase, "teller_refund_customer_payment");
  checks.push({
    name: "removed teller_refund_customer_payment",
    pass: !removed,
    detail: removed ? "still present" : "absent",
  });

  for (const code of ["2300", "6850"]) {
    const { data, error } = await supabase
      .from("teller_accounts")
      .select("code, type, subtype")
      .eq("organization_id", HFAC_ORG_ID)
      .eq("code", code)
      .maybeSingle();
    checks.push({
      name: `HFAC COA ${code}`,
      pass: !error && Boolean(data),
      detail: error?.message ?? JSON.stringify(data),
    });
  }

  const snapshotPath = process.argv[2];
  let hfacEconomicsChanged = null;
  if (snapshotPath && existsSync(snapshotPath)) {
    const before = JSON.parse(readFileSync(snapshotPath, "utf8"));
    const after = {
      documents: await countOrg(supabase, "teller_documents", HFAC_ORG_ID),
      payments: await countOrg(supabase, "teller_payments", HFAC_ORG_ID),
      payment_allocations: await countOrg(supabase, "teller_payment_allocations", HFAC_ORG_ID),
      journal_entries: await countOrg(supabase, "teller_journal_entries", HFAC_ORG_ID),
    };
    hfacEconomicsChanged = Object.keys(after).some(
      (key) => after[key] !== before.hfac.counts[key],
    );
    checks.push({
      name: "HFAC row counts unchanged",
      pass: !hfacEconomicsChanged,
      detail: { before: before.hfac.counts, after },
    });
  }

  const allPass = checks.every((c) => c.pass);
  console.log(JSON.stringify({ allPass, hfacEconomicsChanged, checks }, null, 2));
  if (!allPass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
