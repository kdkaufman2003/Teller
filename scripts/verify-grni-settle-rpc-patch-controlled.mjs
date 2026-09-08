#!/usr/bin/env node
/** Verify deployed GRNI settle RPC no longer references receipt line updated_at. */
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { assertProductionDbUrl } from "./controlled-prod-db-url.mjs";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const SETTLE_RPC = "teller_atomic_settle_inventory_receipt_bill";
const REVERSE_RPC = "teller_atomic_reverse_inventory_receipt_bill_allocation";
const PHASE13_RPCS = [
  "teller_atomic_receive_inventory",
  "teller_atomic_issue_inventory",
  "teller_atomic_transfer_inventory",
  "teller_atomic_reverse_inventory_movement",
  SETTLE_RPC,
  REVERSE_RPC,
];

function rpcCallable(error) {
  if (!error) return true;
  const message = error.message ?? String(error);
  if (/function.*does not exist/i.test(message)) return false;
  if (/schema cache/i.test(message)) return false;
  if (/could not find the function/i.test(message)) return false;
  return true;
}

function settleDefOk(def) {
  if (!def) return false;
  if (!/teller_atomic_settle_inventory_receipt_bill/i.test(def)) return false;
  if (/updated_at\s*=\s*now\(\)/i.test(def) && /teller_purchase_receipt_lines/i.test(def)) {
    return false;
  }
  return true;
}

async function pgVerify(dbUrl) {
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const { rows: settleRows } = await client.query(
      `select pg_get_functiondef(p.oid) as def
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = $1`,
      [SETTLE_RPC],
    );
    const settleOk = settleDefOk(settleRows[0]?.def ?? "");

    const { rows: reverseRows } = await client.query(
      `select pg_get_functiondef(p.oid) as def
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = $1`,
      [REVERSE_RPC],
    );
    const reverseOk = Boolean(reverseRows[0]?.def);

    const { rows: rpcRows } = await client.query(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = any($1::text[])`,
      [PHASE13_RPCS],
    );
    const rpcPresent = Object.fromEntries(
      PHASE13_RPCS.map((name) => [name, rpcRows.some((row) => row.proname === name)]),
    );

    return {
      method: "pg_catalog",
      settleOk,
      reverseOk,
      rpcPresent,
      settleReferencesUpdatedAt: !settleOk,
    };
  } finally {
    await client.end();
  }
}

async function restVerify(supabase) {
  const probes = {
    teller_atomic_receive_inventory: {
      p_organization_id: "00000000-0000-0000-0000-000000000000",
      p_inventory_item_id: "00000000-0000-0000-0000-000000000000",
      p_location_id: "00000000-0000-0000-0000-000000000000",
      p_quantity: 1,
      p_unit_cost: 1,
      p_movement_type: "purchase_receipt",
      p_source_type: "probe",
      p_source_id: "00000000-0000-0000-0000-000000000000",
      p_idempotency_key: "probe:receive",
      p_entry_date: null,
      p_journal_lines: null,
      p_journal_source_kind: null,
      p_journal_source_id: null,
      p_actor_id: null,
    },
    teller_atomic_issue_inventory: {
      p_organization_id: "00000000-0000-0000-0000-000000000000",
      p_inventory_item_id: "00000000-0000-0000-0000-000000000000",
      p_location_id: "00000000-0000-0000-0000-000000000000",
      p_quantity: 1,
      p_movement_type: "job_issue",
      p_idempotency_key: "probe:issue",
      p_actor_id: null,
    },
    teller_atomic_transfer_inventory: {
      p_organization_id: "00000000-0000-0000-0000-000000000000",
      p_inventory_item_id: "00000000-0000-0000-0000-000000000000",
      p_from_location_id: "00000000-0000-0000-0000-000000000000",
      p_to_location_id: "00000000-0000-0000-0000-000000000001",
      p_quantity: 1,
      p_idempotency_key: "probe:transfer",
      p_actor_id: null,
    },
    teller_atomic_reverse_inventory_movement: {
      p_organization_id: "00000000-0000-0000-0000-000000000000",
      p_movement_id: "00000000-0000-0000-0000-000000000000",
      p_idempotency_key: "probe:reverse-move",
      p_actor_id: null,
    },
    [SETTLE_RPC]: {
      p_organization_id: "00000000-0000-0000-0000-000000000000",
      p_receipt_line_id: "00000000-0000-0000-0000-000000000000",
      p_bill_line_id: "00000000-0000-0000-0000-000000000000",
      p_bill_id: "00000000-0000-0000-0000-000000000000",
      p_quantity_matched: 1,
      p_receipt_unit_cost: 1,
      p_bill_unit_cost: 1,
      p_idempotency_key: "probe:settle",
      p_entry_date: "2099-01-01",
      p_journal_lines: [],
      p_actor_id: null,
    },
    [REVERSE_RPC]: {
      p_organization_id: "00000000-0000-0000-0000-000000000000",
      p_allocation_id: "00000000-0000-0000-0000-000000000000",
      p_idempotency_key: "probe:reverse",
      p_entry_date: "2099-01-01",
      p_journal_lines: [],
      p_actor_id: null,
    },
  };

  const rpcPresent = {};
  for (const rpc of PHASE13_RPCS) {
    const { error } = await supabase.rpc(rpc, probes[rpc]);
    rpcPresent[rpc] = rpcCallable(error);
  }

  const { error: settleError } = await supabase.rpc(SETTLE_RPC, probes[SETTLE_RPC]);
  const settleMessage = settleError?.message ?? "";
  const settleOk =
    rpcCallable(settleError) &&
    !/updated_at/i.test(settleMessage) &&
    /Receipt line not found|Not authorized|organization/i.test(settleMessage);

  return {
    method: "rest_probe",
    settleOk,
    reverseOk: rpcPresent[REVERSE_RPC] === true,
    rpcPresent,
    settleProbeError: settleMessage,
    settleReferencesUpdatedAt: /updated_at/i.test(settleMessage),
  };
}

async function main() {
  loadControlledProdEnv();
  const dbUrl = process.env.SUPABASE_DB_URL?.trim();
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const detail = dbUrl
    ? await pgVerify((assertProductionDbUrl(dbUrl), dbUrl))
    : await restVerify(supabase);
  const allRpcsPresent = PHASE13_RPCS.every((name) => detail.rpcPresent[name] === true);
  const ok = detail.settleOk && detail.reverseOk && allRpcsPresent && !detail.settleReferencesUpdatedAt;

  console.log(
    JSON.stringify(
      {
        ok,
        GRNI_SETTLE_RPC_PATCH_VERIFIED: ok,
        detail,
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
