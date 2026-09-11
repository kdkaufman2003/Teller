#!/usr/bin/env node
/** Pre/post Phase 15 deploy controlled production snapshot (read-only). */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";

const TAX_SCHEMA_TABLES = [
  "teller_tax_settings",
  "teller_tax_registrations",
  "teller_tax_transactions",
  "teller_tax_filing_periods",
  "teller_tax_authority_payments",
  "teller_tax_rule_sets",
  "teller_tax_jurisdictions",
  "teller_tax_rates",
  "teller_tax_rate_components",
];

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

async function journalIntegrity(supabase) {
  const byEntry = new Map();
  let totalEntries = 0;
  const pageSize = 100;
  let offset = 0;

  while (true) {
    const { data: entries, error } = await supabase
      .from("teller_journal_entries")
      .select("id")
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    const batch = (entries ?? []).map((row) => row.id);
    if (!batch.length) break;
    totalEntries += batch.length;

    for (let index = 0; index < batch.length; index += 50) {
      const slice = batch.slice(index, index + 50);
      const { data: lines, error: linesError } = await supabase
        .from("teller_journal_lines")
        .select("entry_id, debit, credit")
        .in("entry_id", slice);
      if (linesError) throw new Error(linesError.message);
      for (const line of lines ?? []) {
        const current = byEntry.get(line.entry_id) ?? { debit: 0, credit: 0 };
        current.debit += Number(line.debit ?? 0);
        current.credit += Number(line.credit ?? 0);
        byEntry.set(line.entry_id, current);
      }
    }

    if (batch.length < pageSize) break;
    offset += pageSize;
  }

  let unbalancedCount = 0;
  for (const totals of byEntry.values()) {
    if (Math.abs(totals.debit - totals.credit) > 0.009) unbalancedCount += 1;
  }

  return {
    balanced: unbalancedCount === 0,
    totalEntries,
    unbalancedCount,
  };
}

async function main() {
  loadControlledProdEnv();
  const arg = process.argv[2];
  const label =
    arg === "post-deploy"
      ? "post-phase15-deploy"
      : arg === "pre-deploy"
        ? "pre-phase15-deploy"
        : "pre-phase15-deploy";

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const taxSchemaPresent = {};
  for (const table of TAX_SCHEMA_TABLES) {
    taxSchemaPresent[table] = (await countRows(supabase, table)) != null;
  }

  const snapshot = {
    capturedAt: new Date().toISOString(),
    label,
    snapshotKind: label.startsWith("post-")
      ? "post-phase15-production-baseline"
      : "pre-phase15-production-baseline",
    releaseCommitExpected: "71942a41e743e706273e316274946b8921b80b60",
    hfac: {
      documents: await countRows(supabase, "teller_documents", HFAC_ORG_ID),
      payments: await countRows(supabase, "teller_payments", HFAC_ORG_ID),
      payment_allocations: await countRows(supabase, "teller_payment_allocations", HFAC_ORG_ID),
      journals: await countRows(supabase, "teller_journal_entries", HFAC_ORG_ID),
      tax_transactions: await countRows(supabase, "teller_tax_transactions", HFAC_ORG_ID),
      tax_settings: await countRows(supabase, "teller_tax_settings", HFAC_ORG_ID),
    },
    taxSchemaPresent,
    globalTaxReference: {
      rule_sets: await countRows(supabase, "teller_tax_rule_sets"),
      jurisdictions: await countRows(supabase, "teller_tax_jurisdictions"),
      rates: await countRows(supabase, "teller_tax_rates"),
      rate_components: await countRows(supabase, "teller_tax_rate_components"),
    },
    journalIntegrity: await journalIntegrity(supabase),
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
