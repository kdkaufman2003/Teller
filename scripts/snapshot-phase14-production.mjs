#!/usr/bin/env node
/** Pre Phase 14 deploy controlled production snapshot. */
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
    const message = error.message ?? "";
    if (/does not exist|schema cache/i.test(message)) return null;
    if (!message) return null;
    throw new Error(`${table}: ${message}`);
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
      ? "post-phase14-deploy"
      : arg === "pre-deploy"
        ? "pre-phase14-deploy"
        : "pre-phase14-deploy";
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const snapshot = {
    capturedAt: new Date().toISOString(),
    label,
    snapshotKind: label.startsWith("post-") ? "post-phase14-production-baseline" : "pre-phase14-production-baseline",
    hfac: {
      documents: await countRows(supabase, "teller_documents", HFAC_ORG_ID),
      payments: await countRows(supabase, "teller_payments", HFAC_ORG_ID),
      payment_allocations: await countRows(supabase, "teller_payment_allocations", HFAC_ORG_ID),
      journals: await countRows(supabase, "teller_journal_entries", HFAC_ORG_ID),
      jobs: await countRows(supabase, "teller_jobs", HFAC_ORG_ID),
      vendors: await countRows(supabase, "teller_parties", HFAC_ORG_ID),
      planning_budgets: await countRows(supabase, "teller_budgets", HFAC_ORG_ID),
      planning_forecasts: await countRows(supabase, "teller_forecasts", HFAC_ORG_ID),
      planning_scenarios: await countRows(supabase, "teller_scenarios", HFAC_ORG_ID),
    },
    planningSchemaPresent: {
      teller_planning_settings: (await countRows(supabase, "teller_planning_settings", HFAC_ORG_ID)) != null,
      teller_budgets: (await countRows(supabase, "teller_budgets", HFAC_ORG_ID)) != null,
      teller_forecasts: (await countRows(supabase, "teller_forecasts", HFAC_ORG_ID)) != null,
      teller_cash_forecast_runs: (await countRows(supabase, "teller_cash_forecast_runs", HFAC_ORG_ID)) != null,
      teller_scenarios: (await countRows(supabase, "teller_scenarios", HFAC_ORG_ID)) != null,
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
