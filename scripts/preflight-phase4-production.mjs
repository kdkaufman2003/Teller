#!/usr/bin/env node
/**
 * Read-only Phase 4 production pre-flight (schema + reconciliation + integrity).
 * Usage: TELLER_CONTROLLED_PROD_TEST=1 node scripts/preflight-phase4-production.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";

const PHASE3_TABLES = [
  "teller_payment_allocations",
  "teller_document_allocations",
  "teller_document_journal_links",
];

const PHASE3_RPCS = ["teller_receive_customer_deposit", "teller_apply_deposit_to_invoice"];

const PHASE4_RPCS = [
  "teller_reverse_payment",
  "teller_reverse_deposit_application",
  "teller_reverse_document_allocation",
  "teller_refund_customer_deposit",
  "teller_refund_customer_credit",
  "teller_write_off_invoice",
];

const PHASE4_TABLES = ["teller_write_offs"];

const PHASE4_COLUMNS = [
  ["teller_payment_allocations", "reversal_of_allocation_id"],
  ["teller_payment_allocations", "reversed_by_allocation_id"],
  ["teller_payment_allocations", "reversal_event_id"],
  ["teller_payments", "refund_event_id"],
];

async function tableOk(supabase, table) {
  const { error } = await supabase.from(table).select("id").limit(0);
  return { exists: !error, detail: error?.message ?? "ok" };
}

async function rpcExists(supabase, name) {
  const { error } = await supabase.rpc(name, {});
  if (!error) return true;
  const message = error.message.toLowerCase();
  if (message.includes("does not exist") || message.includes("could not find the function")) {
    return false;
  }
  return true;
}

async function countAll(supabase, table) {
  const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true });
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function countOrg(supabase, table, orgId) {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function journalIntegrity(supabase, orgId) {
  const { data: entries, error: e1 } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId);
  if (e1) throw new Error(e1.message);
  const entryIds = (entries ?? []).map((r) => r.id);
  if (!entryIds.length) return { entryCount: 0, unbalanced: [], orphanLines: 0 };

  const { data: lines, error: e2 } = await supabase
    .from("teller_journal_lines")
    .select("entry_id, debit, credit")
    .in("entry_id", entryIds);
  if (e2) throw new Error(e2.message);

  const byEntry = new Map();
  for (const line of lines ?? []) {
    const id = line.entry_id;
    const row = byEntry.get(id) ?? { debit: 0, credit: 0 };
    row.debit += Number(line.debit ?? 0);
    row.credit += Number(line.credit ?? 0);
    byEntry.set(id, row);
  }

  const unbalanced = [];
  for (const [id, totals] of byEntry) {
    if (Math.abs(totals.debit - totals.credit) > 0.009) {
      unbalanced.push({ entryId: id, ...totals });
    }
  }

  return {
    entryCount: entryIds.length,
    lineCount: (lines ?? []).length,
    unbalanced,
  };
}

async function allocationOrphans(supabase, orgId) {
  const issues = [];

  const { data: payAllocs, error: paErr } = await supabase
    .from("teller_payment_allocations")
    .select("id, payment_id, document_id")
    .eq("organization_id", orgId);
  if (paErr) throw new Error(paErr.message);

  for (const row of payAllocs ?? []) {
    const [{ data: payment }, { data: doc }] = await Promise.all([
      supabase.from("teller_payments").select("id").eq("id", row.payment_id).maybeSingle(),
      supabase.from("teller_documents").select("id").eq("id", row.document_id).maybeSingle(),
    ]);
    if (!payment) issues.push({ kind: "orphan_payment_allocation_payment", id: row.id, ref: row.payment_id });
    if (!doc) issues.push({ kind: "orphan_payment_allocation_document", id: row.id, ref: row.document_id });
  }

  const { data: docAllocs, error: daErr } = await supabase
    .from("teller_document_allocations")
    .select("id, source_document_id, target_document_id")
    .eq("organization_id", orgId);
  if (daErr) throw new Error(daErr.message);

  for (const row of docAllocs ?? []) {
    const [{ data: source }, { data: target }] = await Promise.all([
      supabase.from("teller_documents").select("id").eq("id", row.source_document_id).maybeSingle(),
      supabase.from("teller_documents").select("id").eq("id", row.target_document_id).maybeSingle(),
    ]);
    if (!source) issues.push({ kind: "orphan_doc_alloc_source", id: row.id, ref: row.source_document_id });
    if (!target) issues.push({ kind: "orphan_doc_alloc_target", id: row.id, ref: row.target_document_id });
  }

  return issues;
}

async function glBalanceForSubtype(supabase, orgId, subtype, fallbackCode) {
  const { data: accounts } = await supabase
    .from("teller_accounts")
    .select("id, code, subtype")
    .eq("organization_id", orgId);
  const account = (accounts ?? []).find(
    (a) => a.subtype === subtype || a.code === fallbackCode,
  );
  if (!account) return { account: null, balance: null };

  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId);
  const entryIds = (entries ?? []).map((e) => e.id);
  if (!entryIds.length) return { account: account.code, balance: 0 };

  const { data: lines } = await supabase
    .from("teller_journal_lines")
    .select("debit, credit")
    .eq("account_id", account.id)
    .in("entry_id", entryIds);

  const balance = (lines ?? []).reduce(
    (sum, l) => sum + Number(l.debit ?? 0) - Number(l.credit ?? 0),
    0,
  );
  return { account: account.code, balance: Math.round(balance * 100) / 100 };
}

async function main() {
  const env = loadControlledProdEnv();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const report = {
    capturedAt: new Date().toISOString(),
    projectRef: env.projectRef,
    hfacOrgId: HFAC_ORG_ID,
    schema: { phase3: {}, phase4: {} },
    counts: {},
    hfacOrg: {},
    reconciliation: {},
    integrity: {},
  };

  for (const table of PHASE3_TABLES) {
    report.schema.phase3[table] = await tableOk(supabase, table);
  }
  for (const rpc of PHASE3_RPCS) {
    report.schema.phase3[rpc] = { exists: await rpcExists(supabase, rpc) };
  }

  for (const table of PHASE4_TABLES) {
    report.schema.phase4[table] = await tableOk(supabase, table);
  }
  for (const rpc of PHASE4_RPCS) {
    report.schema.phase4[rpc] = { exists: await rpcExists(supabase, rpc) };
  }
  for (const [table, col] of PHASE4_COLUMNS) {
    const { error } = await supabase.from(table).select(col).limit(0);
    report.schema.phase4[`${table}.${col}`] = { exists: !error, detail: error?.message ?? "ok" };
  }

  report.counts = {
    organizations: await countAll(supabase, "teller_organizations"),
    accounts: await countAll(supabase, "teller_accounts"),
    parties: await countAll(supabase, "teller_parties"),
    documents: await countAll(supabase, "teller_documents"),
    payments: await countAll(supabase, "teller_payments"),
    payment_allocations: await countAll(supabase, "teller_payment_allocations"),
    document_allocations: await countAll(supabase, "teller_document_allocations"),
    journal_entries: await countAll(supabase, "teller_journal_entries"),
    journal_lines: await countAll(supabase, "teller_journal_lines"),
  };

  const { data: hfacOrg, error: hfacErr } = await supabase
    .from("teller_organizations")
    .select("id, name, legal_name, industry_id, setup_completed_at")
    .eq("id", HFAC_ORG_ID)
    .maybeSingle();
  report.hfacOrg.found = Boolean(hfacOrg) && !hfacErr;
  report.hfacOrg.row = hfacOrg ?? null;
  report.hfacOrg.error = hfacErr?.message ?? null;

  if (hfacOrg) {
    report.hfacOrg.counts = {
      accounts: await countOrg(supabase, "teller_accounts", HFAC_ORG_ID),
      parties: await countOrg(supabase, "teller_parties", HFAC_ORG_ID),
      documents: await countOrg(supabase, "teller_documents", HFAC_ORG_ID),
      payments: await countOrg(supabase, "teller_payments", HFAC_ORG_ID),
      payment_allocations: await countOrg(supabase, "teller_payment_allocations", HFAC_ORG_ID),
      document_allocations: await countOrg(supabase, "teller_document_allocations", HFAC_ORG_ID),
      journal_entries: await countOrg(supabase, "teller_journal_entries", HFAC_ORG_ID),
    };

    report.reconciliation.arGl = await glBalanceForSubtype(supabase, HFAC_ORG_ID, "receivable", "1100");
    report.reconciliation.apGl = await glBalanceForSubtype(supabase, HFAC_ORG_ID, "payable", "2000");
    report.reconciliation.depositsGl = await glBalanceForSubtype(supabase, HFAC_ORG_ID, "deposit", "2300");

    report.integrity.journals = await journalIntegrity(supabase, HFAC_ORG_ID);
    report.integrity.allocationOrphans = await allocationOrphans(supabase, HFAC_ORG_ID);
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
