#!/usr/bin/env node
/**
 * Post-migration 024 structural + security verification on controlled production.
 */
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";
import { assertProductionDbUrl } from "./controlled-prod-db-url.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";
const EXPECTED_HFAC = {
  documents: 8,
  payments: 3,
  payment_allocations: 3,
  document_allocations: 0,
  journal_entries: 16,
  jobs: 0,
  vendors: 2,
  ar: 1500,
  ap: 0,
};

const PHASE8_TABLES = [
  "teller_fixed_asset_settings",
  "teller_fixed_asset_categories",
  "teller_fixed_assets",
  "teller_fixed_asset_depreciation_schedule_lines",
  "teller_fixed_asset_depreciation_batches",
  "teller_fixed_asset_depreciation_entries",
  "teller_fixed_asset_journal_links",
  "teller_fixed_asset_disposal_idempotency",
];

async function tableExists(supabase, table) {
  const { error } = await supabase.from(table).select("*").limit(1);
  if (!error) return true;
  const msg = (error.message ?? "").toLowerCase();
  return !(msg.includes("does not exist") || msg.includes("schema cache"));
}

async function columnExists(supabase, table, column) {
  if (!(await tableExists(supabase, table))) return false;
  const { error } = await supabase.from(table).select(column).limit(0);
  if (!error) return true;
  return !(error.message ?? "").toLowerCase().includes("column");
}

async function countRows(supabase, table, orgId = null) {
  let q = supabase.from(table).select("id", { count: "exact", head: true });
  if (orgId) q = q.eq("organization_id", orgId);
  const { count, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function glBalance(supabase, orgId, code) {
  const { data: accts } = await supabase
    .from("teller_accounts")
    .select("id")
    .eq("organization_id", orgId)
    .eq("code", code);
  const id = accts?.[0]?.id;
  if (!id) return null;
  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId);
  const ids = (entries ?? []).map((e) => e.id);
  if (!ids.length) return 0;
  const { data: lines } = await supabase
    .from("teller_journal_lines")
    .select("debit, credit")
    .eq("account_id", id)
    .in("entry_id", ids);
  return Math.round(
    (lines ?? []).reduce((sum, l) => sum + Number(l.debit ?? 0) - Number(l.credit ?? 0), 0) * 100,
  ) / 100;
}

async function journalBalanceCheck(supabase, orgId = null) {
  let q = supabase.from("teller_journal_entries").select("id");
  if (orgId) q = q.eq("organization_id", orgId);
  const { data: entries } = await q;
  const ids = (entries ?? []).map((e) => e.id);
  if (!ids.length) return { total: 0, unbalanced: 0 };
  const { data: lines } = await supabase
    .from("teller_journal_lines")
    .select("entry_id, debit, credit")
    .in("entry_id", ids);
  const byEntry = new Map();
  for (const line of lines ?? []) {
    const row = byEntry.get(line.entry_id) ?? { debit: 0, credit: 0 };
    row.debit += Number(line.debit ?? 0);
    row.credit += Number(line.credit ?? 0);
    byEntry.set(line.entry_id, row);
  }
  let unbalanced = 0;
  for (const totals of byEntry.values()) {
    if (Math.abs(totals.debit - totals.credit) > 0.009) unbalanced += 1;
  }
  return { total: ids.length, unbalanced };
}

async function functionGrants(client) {
  const names = [
    "teller_dispose_fixed_asset",
    "teller_dispose_fixed_asset_controlled_test",
    "teller_dispose_fixed_asset_core",
  ];
  const { rows } = await client.query(
    `
    select
      p.proname as name,
      r.rolname as grantee
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    left join lateral (
      select grantee::regrole::text as rolname
      from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))
    ) r on true
    where n.nspname = 'public'
      and p.proname = any($1::text[])
    order by p.proname, r.rolname
    `,
    [names],
  );
  const grants = {};
  for (const name of names) grants[name] = [];
  for (const row of rows) {
    if (!row.grantee) continue;
    grants[row.name] = grants[row.name] ?? [];
    grants[row.name].push(row.grantee);
  }
  return grants;
}

async function rlsEnabled(client, tables) {
  const { rows } = await client.query(
    `
    select c.relname as table_name, c.relrowsecurity as rls_enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = any($1::text[])
    `,
    [tables],
  );
  const out = {};
  for (const table of tables) out[table] = false;
  for (const row of rows) out[row.table_name] = row.rls_enabled === true;
  return out;
}

async function productionDisposeHasSimulateParam(client) {
  const { rows } = await client.query(
    `
    select pg_get_function_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'teller_dispose_fixed_asset'
    limit 1
    `,
  );
  const args = rows[0]?.args ?? "";
  return args.includes("p_simulate_failure_after");
}

async function main() {
  loadControlledProdEnv();
  const projectRef = assertProductionDbUrl(process.env.SUPABASE_DB_URL);

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_URL.trim(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const tables = {};
    for (const table of PHASE8_TABLES) {
      tables[table] = await tableExists(supabase, table);
    }
    const fixedAssetColumn = await columnExists(supabase, "teller_journal_lines", "fixed_asset_id");

    const grants = await functionGrants(client);
    const rls = await rlsEnabled(client, PHASE8_TABLES);
    const productionHasTestHook = await productionDisposeHasSimulateParam(client);

    const compat = spawnSync("node", ["scripts/audit-phase8-deployment-compat.mjs"], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    let compatReport = {};
    try {
      const jsonStart = compat.stdout.indexOf("{");
      compatReport = JSON.parse(compat.stdout.slice(jsonStart));
    } catch {
      compatReport = { parseError: true };
    }

    const hfac = {
      documents: await countRows(supabase, "teller_documents", HFAC_ORG_ID),
      payments: await countRows(supabase, "teller_payments", HFAC_ORG_ID),
      payment_allocations: await countRows(supabase, "teller_payment_allocations", HFAC_ORG_ID),
      document_allocations: await countRows(supabase, "teller_document_allocations", HFAC_ORG_ID),
      journal_entries: await countRows(supabase, "teller_journal_entries", HFAC_ORG_ID),
      jobs: await countRows(supabase, "teller_jobs", HFAC_ORG_ID),
      vendors: await (async () => {
        const { count } = await supabase
          .from("teller_parties")
          .select("*", { count: "exact", head: true })
          .eq("organization_id", HFAC_ORG_ID)
          .in("kind", ["vendor", "both"]);
        return count ?? 0;
      })(),
      fixed_assets: await countRows(supabase, "teller_fixed_assets", HFAC_ORG_ID),
      depreciation_entries: await countRows(
        supabase,
        "teller_fixed_asset_depreciation_entries",
        HFAC_ORG_ID,
      ),
      ar: await glBalance(supabase, HFAC_ORG_ID, "1100"),
      ap: await glBalance(supabase, HFAC_ORG_ID, "2000"),
    };

    const hfacJournals = await journalBalanceCheck(supabase, HFAC_ORG_ID);
    const prodJournals = await journalBalanceCheck(supabase);

    const hfacBaselineMatches =
      hfac.documents === EXPECTED_HFAC.documents &&
      hfac.payments === EXPECTED_HFAC.payments &&
      hfac.payment_allocations === EXPECTED_HFAC.payment_allocations &&
      hfac.document_allocations === EXPECTED_HFAC.document_allocations &&
      hfac.journal_entries === EXPECTED_HFAC.journal_entries &&
      hfac.jobs === EXPECTED_HFAC.jobs &&
      hfac.vendors === EXPECTED_HFAC.vendors &&
      Math.abs((hfac.ar ?? 0) - EXPECTED_HFAC.ar) < 0.01 &&
      Math.abs((hfac.ap ?? 0) - EXPECTED_HFAC.ap) < 0.01 &&
      hfac.fixed_assets === 0 &&
      hfac.depreciation_entries === 0 &&
      hfacJournals.unbalanced === 0;

    const structuralOk =
      Object.values(tables).every(Boolean) &&
      fixedAssetColumn &&
      !productionHasTestHook &&
      !(grants.teller_dispose_fixed_asset_core ?? []).some((g) =>
        ["authenticated", "anon", "public"].includes(g),
      ) &&
      (grants.teller_dispose_fixed_asset ?? []).includes("authenticated") &&
      (grants.teller_dispose_fixed_asset_controlled_test ?? []).includes("service_role") &&
      !(grants.teller_dispose_fixed_asset_controlled_test ?? []).includes("authenticated") &&
      Object.values(rls).every(Boolean);

    const report = {
      MIGRATION_024_STRUCTURAL_VERIFY: structuralOk,
      OLD_POST_JOURNAL_CALLERS_COMPATIBLE: compatReport.OLD_POST_JOURNAL_CALLERS_COMPATIBLE ?? false,
      PRODUCTION_DISPOSAL_RPC_HAS_TEST_HOOK: productionHasTestHook,
      RPC_GRANTS: grants,
      RLS_ENABLED: rls,
      schemaProbe: { tables, fixed_asset_id_column: fixedAssetColumn },
      hfac,
      hfacBaselineMatches,
      hfacJournalsBalanced: hfacJournals.unbalanced === 0,
      productionJournalsBalanced: prodJournals.unbalanced === 0,
      productionJournalCount: prodJournals.total,
      projectRef,
    };

    console.log(JSON.stringify(report, null, 2));
    process.exit(structuralOk && hfacBaselineMatches && compatReport.OLD_POST_JOURNAL_CALLERS_COMPATIBLE ? 0 : 2);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
