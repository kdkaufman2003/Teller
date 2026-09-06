#!/usr/bin/env node
/**
 * Read-only Phase 4 schema verification against isolated Supabase.
 * Usage: npm run verify:integration-schema
 */
import { createClient } from "@supabase/supabase-js";
import { loadIntegrationEnv } from "./load-integration-env.mjs";

const PHASE4_RPCS = [
  "teller_reverse_payment",
  "teller_reverse_deposit_application",
  "teller_reverse_document_allocation",
  "teller_refund_customer_deposit",
  "teller_refund_customer_credit",
  "teller_write_off_invoice",
];

const REMOVED_RPC = "teller_refund_customer_payment";

async function rpcExists(supabase, name) {
  const { data, error } = await supabase.rpc(name, {});
  if (!error) return true;
  const message = error.message.toLowerCase();
  if (message.includes("does not exist")) return false;
  if (message.includes("could not find the function")) return false;
  // Wrong args still means the function exists.
  return true;
}

async function main() {
  loadIntegrationEnv({ required: true });

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const checks = [];

  const { error: writeOffTableError } = await supabase
    .from("teller_write_offs")
    .select("id", { count: "exact", head: true });
  checks.push({
    name: "teller_write_offs table",
    pass: !writeOffTableError,
    detail: writeOffTableError?.message ?? "ok",
  });

  for (const column of [
    "reversal_of_allocation_id",
    "reversed_by_allocation_id",
    "reversal_event_id",
    "refund_event_id",
  ]) {
    const table = column.includes("refund") ? "teller_payments" : "teller_payment_allocations";
    const { error } = await supabase.from(table).select(column).limit(0);
    checks.push({
      name: `${table}.${column}`,
      pass: !error,
      detail: error?.message ?? "ok",
    });
  }

  for (const rpc of PHASE4_RPCS) {
    const exists = await rpcExists(supabase, rpc);
    checks.push({ name: `rpc ${rpc}`, pass: exists, detail: exists ? "present" : "missing" });
  }

  const removedExists = await rpcExists(supabase, REMOVED_RPC);
  checks.push({
    name: `removed rpc ${REMOVED_RPC}`,
    pass: !removedExists,
    detail: removedExists ? "still present" : "absent as expected",
  });

  const { organizationId, accountIds } = await createProbeOrg(supabase);
  try {
    for (const code of ["2300", "6850"]) {
      const { data, error } = await supabase
        .from("teller_accounts")
        .select("code, name, type, subtype")
        .eq("organization_id", organizationId)
        .eq("code", code)
        .maybeSingle();
      checks.push({
        name: `COA ${code}`,
        pass: !error && Boolean(data),
        detail: error?.message ?? JSON.stringify(data),
      });
    }
  } finally {
    await supabase.from("teller_organizations").delete().eq("id", organizationId);
  }

  const allPass = checks.every((check) => check.pass);
  console.log(JSON.stringify({ allPass, checks, accountIdsProbe: accountIds }, null, 2));
  if (!allPass) process.exitCode = 1;
}

async function createProbeOrg(supabase) {
  const suffix = `schema-probe-${Date.now()}`;
  const { data: org, error: orgError } = await supabase
    .from("teller_organizations")
    .insert({
      name: suffix,
      legal_name: suffix,
      industry_id: "hvac-residential",
      setup_completed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (orgError || !org) throw new Error(orgError?.message || "Could not create probe org");

  const seeds = [
    { code: "2300", name: "Customer Deposits", type: "liability", subtype: "deposit" },
    { code: "6850", name: "Bad Debt Expense", type: "expense", subtype: "bad_debt" },
  ];
  const { data: accounts, error: accountsError } = await supabase
    .from("teller_accounts")
    .insert(
      seeds.map((row) => ({
        organization_id: org.id,
        code: row.code,
        name: row.name,
        type: row.type,
        subtype: row.subtype,
        is_system: true,
      })),
    )
    .select("id, code, type, subtype");
  if (accountsError) throw new Error(accountsError.message);

  const accountIds = Object.fromEntries((accounts ?? []).map((row) => [row.code, row.id]));
  return { organizationId: org.id, accountIds };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
