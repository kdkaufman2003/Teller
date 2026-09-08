#!/usr/bin/env node
/** Pre/post Phase 13 controlled production snapshot. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";

async function countRows(supabase, table, orgId = null) {
  let query = supabase.from(table).select("id", { count: "exact", head: true });
  if (orgId) query = query.eq("organization_id", orgId);
  const { count, error } = await query;
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return null;
    throw new Error(`${table}: ${error.message}`);
  }
  return count ?? 0;
}

async function allJournalsBalanced(supabase) {
  const { data: entries, error } = await supabase.from("teller_journal_entries").select("id");
  if (error) throw new Error(error.message);
  const ids = (entries ?? []).map((row) => row.id);
  if (ids.length === 0) return true;

  const { data: lines, error: linesError } = await supabase
    .from("teller_journal_lines")
    .select("entry_id, debit, credit")
    .in("entry_id", ids);
  if (linesError) throw new Error(linesError.message);

  const byEntry = new Map();
  for (const line of lines ?? []) {
    const current = byEntry.get(line.entry_id) ?? { debit: 0, credit: 0 };
    current.debit += Number(line.debit ?? 0);
    current.credit += Number(line.credit ?? 0);
    byEntry.set(line.entry_id, current);
  }
  for (const totals of byEntry.values()) {
    if (Math.abs(totals.debit - totals.credit) > 0.01) return false;
  }
  return true;
}

async function main() {
  loadControlledProdEnv();
  const arg = process.argv[2];
  const label =
    arg === "post-deploy"
      ? "post-phase13-deploy"
      : arg === "pre-deploy"
        ? "pre-phase13-deploy"
        : arg === "post-postpatch"
          ? "post-phase13-postpatch-acceptance"
          : arg === "pre-postpatch"
            ? "pre-phase13-postpatch-acceptance"
            : arg === "post"
              ? "post-phase13-acceptance"
              : arg === "pre"
                ? "pre-phase13-acceptance"
                : "pre-phase13-acceptance";
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const snapshot = {
    capturedAt: new Date().toISOString(),
    label,
    hfac: {
      documents: await countRows(supabase, "teller_documents", HFAC_ORG_ID),
      journals: await countRows(supabase, "teller_journal_entries", HFAC_ORG_ID),
      phase13_inventory_items: await countRows(supabase, "teller_inventory_items", HFAC_ORG_ID),
      phase13_inventory_locations: await countRows(supabase, "teller_inventory_locations", HFAC_ORG_ID),
      phase13_inventory_movements: await countRows(supabase, "teller_inventory_movements", HFAC_ORG_ID),
      phase13_inventory_balances: await countRows(supabase, "teller_inventory_balances", HFAC_ORG_ID),
      phase13_grni_allocations: await countRows(supabase, "teller_inventory_receipt_bill_allocations", HFAC_ORG_ID),
      phase12_payroll_runs: await countRows(supabase, "teller_payroll_runs", HFAC_ORG_ID),
    },
    productionJournalsBalanced: await allJournalsBalanced(supabase),
  };

  const dir = resolve(process.cwd(), "artifacts/controlled-prod-snapshots");
  mkdirSync(dir, { recursive: true });
  const stamp = snapshot.capturedAt.replace(/[:.]/g, "-");
  const jsonPath = resolve(dir, `${label}-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2));
  console.log(JSON.stringify({ ok: true, jsonPath, snapshot }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
