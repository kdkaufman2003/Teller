#!/usr/bin/env node
/** Verify migration 016 schema + production economics unchanged vs baseline snapshot. */
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import pg from "pg";
import { assertProductionDbUrl } from "./controlled-prod-db-url.mjs";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";

const DEPOSIT_INDEXES = [
  "teller_payment_allocations_app_journal_idx",
  "teller_payment_allocations_org_event_idx",
  "teller_payment_allocations_payment_doc_kind_idx",
  "teller_journal_entries_deposit_application_event_idx",
  "teller_payments_org_deposit_idx",
  "teller_payments_org_receipt_event_idx",
  "teller_journal_entries_deposit_receipt_event_idx",
];

const DEPOSIT_RPCS = ["teller_receive_customer_deposit", "teller_apply_deposit_to_invoice"];

const BASELINE_COUNTS = {
  payments: 3,
  payment_allocations: 3,
  journal_entries: 16,
  journal_lines: 32,
};

const BASELINE_GL = {
  ar: 1500,
  ap: 0,
};

async function countAll(supabase, table) {
  const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true });
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function countJournalLines(supabase) {
  const { count, error } = await supabase
    .from("teller_journal_lines")
    .select("id", { count: "exact", head: true });
  if (error) throw new Error(`teller_journal_lines: ${error.message}`);
  return count ?? 0;
}

async function glBalanceForSubtype(supabase, orgId, subtype, fallbackCode) {
  const { data: accounts, error: accountsError } = await supabase
    .from("teller_accounts")
    .select("id, code, subtype")
    .eq("organization_id", orgId);
  if (accountsError) throw new Error(accountsError.message);

  const account = (accounts ?? []).find(
    (row) => row.subtype === subtype || row.code === fallbackCode,
  );
  if (!account) return null;

  const { data: entries, error: entriesError } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId);
  if (entriesError) throw new Error(entriesError.message);

  const entryIds = (entries ?? []).map((row) => row.id);
  if (!entryIds.length) return 0;

  const { data: lines, error: linesError } = await supabase
    .from("teller_journal_lines")
    .select("debit, credit")
    .eq("account_id", account.id)
    .in("entry_id", entryIds);
  if (linesError) throw new Error(linesError.message);

  const balance = (lines ?? []).reduce(
    (sum, line) => sum + Number(line.debit ?? 0) - Number(line.credit ?? 0),
    0,
  );
  return Math.round(balance * 100) / 100;
}

async function verifyCatalogWithPg(dbUrl, checks) {
  assertProductionDbUrl(dbUrl);
  const client = new pg.Client({ connectionString: dbUrl.trim(), ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const columnResult = await client.query(
      `
        select table_name, column_name
        from information_schema.columns
        where table_schema = 'public'
          and (
            (table_name = 'teller_payment_allocations' and column_name in ('application_journal_entry_id', 'application_event_id'))
            or (table_name = 'teller_payments' and column_name = 'receipt_event_id')
          )
      `,
    );
    const columns = new Set(
      columnResult.rows.map((row) => `${row.table_name}.${row.column_name}`),
    );
    for (const name of [
      "teller_payment_allocations.application_journal_entry_id",
      "teller_payment_allocations.application_event_id",
      "teller_payments.receipt_event_id",
    ]) {
      checks.push({
        name,
        pass: columns.has(name),
        detail: columns.has(name) ? "present (pg_catalog)" : "missing",
      });
    }

    const indexResult = await client.query(
      `
        select indexname
        from pg_indexes
        where schemaname = 'public'
          and indexname = any($1::text[])
      `,
      [DEPOSIT_INDEXES],
    );
    const indexes = new Set(indexResult.rows.map((row) => row.indexname));
    for (const indexName of DEPOSIT_INDEXES) {
      checks.push({
        name: `index ${indexName}`,
        pass: indexes.has(indexName),
        detail: indexes.has(indexName) ? "present (pg_catalog)" : "missing",
      });
    }

    const functionResult = await client.query(
      `
        select p.proname
        from pg_proc p
        inner join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = any($1::text[])
      `,
      [DEPOSIT_RPCS],
    );
    const functions = new Set(functionResult.rows.map((row) => row.proname));
    for (const rpcName of DEPOSIT_RPCS) {
      checks.push({
        name: `rpc ${rpcName}`,
        pass: functions.has(rpcName),
        detail: functions.has(rpcName) ? "present (pg_catalog)" : "missing",
      });
    }

    const constraintResult = await client.query(
      `
        select pg_get_constraintdef(c.oid) as definition
        from pg_constraint c
        inner join pg_class t on t.oid = c.conrelid
        inner join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public'
          and t.relname = 'teller_document_journal_links'
          and c.conname = 'teller_document_journal_links_kind_check'
      `,
    );
    const definition = constraintResult.rows[0]?.definition ?? "";
    const acceptsDepositApplication = definition.includes("deposit_application");
    checks.push({
      name: "teller_document_journal_links accepts deposit_application",
      pass: acceptsDepositApplication,
      detail: acceptsDepositApplication ? definition : definition || "constraint missing",
    });
  } finally {
    await client.end();
  }
}

async function verifyColumnsWithSupabase(supabase, checks) {
  for (const [table, column] of [
    ["teller_payment_allocations", "application_journal_entry_id"],
    ["teller_payment_allocations", "application_event_id"],
    ["teller_payments", "receipt_event_id"],
  ]) {
    const { error } = await supabase.from(table).select(column).limit(0);
    checks.push({
      name: `${table}.${column}`,
      pass: !error,
      detail: error?.message ?? "present (supabase)",
    });
  }
}

async function main() {
  const info = loadControlledProdEnv();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const checks = [];
  const dbUrl = process.env.SUPABASE_DB_URL?.trim();

  if (dbUrl) {
    await verifyCatalogWithPg(dbUrl, checks);
  } else {
    await verifyColumnsWithSupabase(supabase, checks);
    checks.push({
      name: "pg_catalog deposit indexes",
      pass: false,
      detail: "SUPABASE_DB_URL required for index verification",
    });
    checks.push({
      name: "pg_catalog deposit RPCs",
      pass: false,
      detail: "SUPABASE_DB_URL required for RPC verification",
    });
    checks.push({
      name: "pg_catalog deposit_application constraint",
      pass: false,
      detail: "SUPABASE_DB_URL required for constraint verification",
    });
  }

  const counts = {
    payments: await countAll(supabase, "teller_payments"),
    payment_allocations: await countAll(supabase, "teller_payment_allocations"),
    journal_entries: await countAll(supabase, "teller_journal_entries"),
    journal_lines: await countJournalLines(supabase),
    documents: await countAll(supabase, "teller_documents"),
  };

  for (const [key, expected] of Object.entries(BASELINE_COUNTS)) {
    checks.push({
      name: `global ${key}`,
      pass: counts[key] === expected,
      detail: { expected, actual: counts[key] },
    });
  }

  const arBalance = await glBalanceForSubtype(supabase, HFAC_ORG_ID, "receivable", "1100");
  const apBalance = await glBalanceForSubtype(supabase, HFAC_ORG_ID, "payable", "2000");

  checks.push({
    name: "HFAC AR (1100)",
    pass: arBalance === BASELINE_GL.ar,
    detail: { expected: BASELINE_GL.ar, actual: arBalance },
  });
  checks.push({
    name: "HFAC AP (2000)",
    pass: apBalance === BASELINE_GL.ap,
    detail: { expected: BASELINE_GL.ap, actual: apBalance },
  });

  const snapshotPath = process.argv[2];
  let economicsChanged = null;
  if (snapshotPath && existsSync(snapshotPath)) {
    const before = JSON.parse(readFileSync(snapshotPath, "utf8"));
    const beforeCounts = before.globalCounts ?? before.hfac?.counts ?? {};
    economicsChanged = ["documents", "payments", "payment_allocations", "journal_entries"].some(
      (key) => counts[key] !== beforeCounts[key],
    );
    checks.push({
      name: "financial row counts unchanged vs snapshot",
      pass: !economicsChanged,
      detail: { before: beforeCounts, after: counts },
    });
  }

  const allPass = checks.every((check) => check.pass);
  console.log(
    JSON.stringify(
      {
        allPass,
        projectRef: info.projectRef,
        economicsChanged,
        counts,
        hfacGl: { ar: arBalance, ap: apBalance },
        checks,
      },
      null,
      2,
    ),
  );
  if (!allPass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
