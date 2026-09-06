#!/usr/bin/env node
/**
 * Read-only Phase 6 production schema audit (021/022).
 * Uses Supabase REST when SUPABASE_DB_URL unavailable; pg catalog when available.
 * Does NOT apply migrations or mutate data.
 */
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";
import { assertProductionDbUrl } from "./controlled-prod-db-url.mjs";

const { Client } = pg;

// --- expected objects from migration source ---

const TABLES_021 = ["teller_ap_settings"];
const TABLES_022 = [
  "teller_purchase_orders",
  "teller_purchase_order_lines",
  "teller_purchase_receipts",
  "teller_purchase_receipt_lines",
  "teller_recurring_bill_templates",
  "teller_recurring_bill_template_lines",
];

const COLS_021_PARTIES = [
  "legal_name",
  "party_status",
  "vendor_category",
  "website",
  "billing_address_line1",
  "billing_address_line2",
  "billing_city",
  "billing_state",
  "billing_postal",
  "billing_country",
  "account_number",
  "default_expense_account_id",
  "default_cogs_account_id",
  "payment_terms",
  "default_due_days",
  "preferred_payment_method",
  "eligible_1099",
  "form_1099_category",
  "w9_received",
  "w9_received_at",
  "vendor_metadata",
];

const COLS_021_DOC_LINES = ["job_id", "cost_category", "cost_type"];
const COLS_021_DOCUMENTS = [
  "purchase_order_id",
  "submitted_by",
  "submitted_at",
  "approved_by",
  "approved_at",
  "rejection_reason",
];

const COLS_022 = {
  teller_purchase_orders: [
    "id",
    "organization_id",
    "number",
    "party_id",
    "job_id",
    "status",
    "issue_date",
    "expected_date",
    "ship_to",
    "buyer_name",
    "vendor_message",
    "memo",
    "subtotal",
    "tax",
    "total",
    "submitted_by",
    "submitted_at",
    "approved_by",
    "approved_at",
    "rejection_reason",
    "created_by",
    "created_at",
    "updated_at",
  ],
  teller_purchase_order_lines: [
    "id",
    "organization_id",
    "purchase_order_id",
    "description",
    "quantity",
    "unit_cost",
    "amount",
    "account_id",
    "job_id",
    "cost_category",
    "cost_type",
    "quantity_received",
    "quantity_billed",
    "sort_order",
    "created_at",
  ],
  teller_purchase_receipts: [
    "id",
    "organization_id",
    "purchase_order_id",
    "receipt_date",
    "reference_number",
    "received_by",
    "location",
    "memo",
    "created_by",
    "created_at",
  ],
  teller_purchase_receipt_lines: [
    "id",
    "organization_id",
    "receipt_id",
    "purchase_order_line_id",
    "quantity_received",
    "created_at",
  ],
  teller_recurring_bill_templates: [
    "id",
    "organization_id",
    "name",
    "party_id",
    "job_id",
    "recurrence",
    "start_date",
    "end_date",
    "issue_day_of_month",
    "terms",
    "default_due_days",
    "memo",
    "tax",
    "active",
    "last_generated_at",
    "created_by",
    "created_at",
    "updated_at",
  ],
  teller_recurring_bill_template_lines: [
    "id",
    "template_id",
    "description",
    "quantity",
    "unit_price",
    "amount",
    "account_id",
    "job_id",
    "cost_category",
    "cost_type",
    "sort_order",
  ],
};

function columnMissing(error) {
  const msg = (error?.message ?? "").toLowerCase();
  return msg.includes("column") && (msg.includes("does not exist") || msg.includes("could not find"));
}

function tableMissing(error) {
  const msg = (error?.message ?? "").toLowerCase();
  return (
    msg.includes("does not exist") ||
    msg.includes("could not find the table") ||
    msg.includes("schema cache")
  );
}

async function restTableExists(supabase, table) {
  const { error } = await supabase.from(table).select("id", { count: "exact", head: true });
  if (!error) return true;
  if (tableMissing(error)) return false;
  // table exists but maybe no id column on some tables - try count without select
  const { error: e2 } = await supabase.from(table).select("*", { count: "exact", head: true });
  if (!e2) return true;
  if (tableMissing(e2)) return false;
  return true; // exists with some other error (RLS etc.)
}

async function restColumnExists(supabase, table, column) {
  const exists = await restTableExists(supabase, table);
  if (!exists) return false;
  const { error } = await supabase.from(table).select(column).limit(0);
  if (!error) return true;
  if (columnMissing(error)) return false;
  return true;
}

async function restRowCount(supabase, table) {
  const exists = await restTableExists(supabase, table);
  if (!exists) return null;
  const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
  if (error) return null;
  return count ?? 0;
}

async function restStatusAllowsPendingApproval(supabase) {
  // Try inserting nothing — probe by selecting bills with pending_approval if column works
  const { error } = await supabase
    .from("teller_documents")
    .select("id")
    .eq("status", "pending_approval")
    .limit(0);
  if (!error) return true;
  const msg = (error.message ?? "").toLowerCase();
  if (msg.includes("invalid input value for enum") || msg.includes("check constraint")) return false;
  return null;
}

async function auditViaPg(dbUrl) {
  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const out = { mode: "pg_catalog" };

  async function tableExists(table) {
    const { rows } = await client.query(
      `select 1 from information_schema.tables where table_schema='public' and table_name=$1`,
      [table],
    );
    return rows.length > 0;
  }
  async function columnExists(table, column) {
    const { rows } = await client.query(
      `select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2`,
      [table, column],
    );
    return rows.length > 0;
  }
  async function constraintExists(table, name) {
    const { rows } = await client.query(
      `select 1 from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
       where n.nspname='public' and t.relname=$1 and c.conname=$2`,
      [table, name],
    );
    return rows.length > 0;
  }
  async function indexExists(name) {
    const { rows } = await client.query(
      `select 1 from pg_indexes where schemaname='public' and indexname=$1`,
      [name],
    );
    return rows.length > 0;
  }
  async function policyExists(table, name) {
    const { rows } = await client.query(
      `select 1 from pg_policies where schemaname='public' and tablename=$1 and policyname=$2`,
      [table, name],
    );
    return rows.length > 0;
  }
  async function rlsEnabled(table) {
    const { rows } = await client.query(
      `select c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname=$1 and c.relkind='r'`,
      [table],
    );
    return rows[0]?.rls ?? null;
  }
  async function rowCount(table) {
    if (!(await tableExists(table))) return null;
    const { rows } = await client.query(`select count(*)::bigint c from public.${table}`);
    return Number(rows[0].c);
  }
  async function statusCheckDef() {
    const { rows } = await client.query(
      `select pg_get_constraintdef(c.oid) def from pg_constraint c
       join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
       where n.nspname='public' and t.relname='teller_documents' and c.conname='teller_documents_status_check'`,
    );
    return rows[0]?.def ?? null;
  }

  try {
    out.catalog = await buildReport({
      tableExists,
      columnExists,
      constraintExists,
      indexExists,
      policyExists,
      rlsEnabled,
      rowCount,
      statusCheckDef: async () => {
        const def = await statusCheckDef();
        return def ? def.includes("pending_approval") : null;
      },
    });
  } finally {
    await client.end();
  }
  return out;
}

async function auditViaRest(supabase) {
  const tableExists = (t) => restTableExists(supabase, t);
  const columnExists = (t, c) => restColumnExists(supabase, t, c);
  const rowCount = (t) => restRowCount(supabase, t);

  return {
    mode: "supabase_rest_probe",
    limitation:
      "Indexes, constraints, policies, RLS, triggers, and functions require SUPABASE_DB_URL for pg_catalog audit.",
    catalog: await buildReport({
      tableExists,
      columnExists,
      constraintExists: async () => null,
      indexExists: async () => null,
      policyExists: async () => null,
      rlsEnabled: async () => null,
      rowCount,
      statusCheckDef: () => restStatusAllowsPendingApproval(supabase),
    }),
  };
}

async function buildReport(probes) {
  const partiesCols = Object.fromEntries(
    await Promise.all(
      COLS_021_PARTIES.map(async (c) => [c, await probes.columnExists("teller_parties", c)]),
    ),
  );
  const docLineCols = Object.fromEntries(
    await Promise.all(
      COLS_021_DOC_LINES.map(async (c) => [
        c,
        await probes.columnExists("teller_document_lines", c),
      ]),
    ),
  );
  const docCols = Object.fromEntries(
    await Promise.all(
      COLS_021_DOCUMENTS.map(async (c) => [c, await probes.columnExists("teller_documents", c)]),
    ),
  );
  const tables021 = Object.fromEntries(
    await Promise.all(TABLES_021.map(async (t) => [t, await probes.tableExists(t)])),
  );
  const tables022 = Object.fromEntries(
    await Promise.all(TABLES_022.map(async (t) => [t, await probes.tableExists(t)])),
  );

  const cols022Missing = [];
  for (const [table, cols] of Object.entries(COLS_022)) {
    if (!(await probes.tableExists(table))) continue;
    for (const col of cols) {
      if (!(await probes.columnExists(table, col))) cols022Missing.push(`${table}.${col}`);
    }
  }

  const rowCounts022 = Object.fromEntries(
    await Promise.all(TABLES_022.map(async (t) => [t, await probes.rowCount(t)])),
  );

  const indexes021 = {
    teller_document_lines_job_idx: await probes.indexExists("teller_document_lines_job_idx"),
    teller_documents_ap_aging_idx: await probes.indexExists("teller_documents_ap_aging_idx"),
    teller_documents_vendor_invoice_idx: await probes.indexExists(
      "teller_documents_vendor_invoice_idx",
    ),
  };
  const indexes022 = {
    teller_purchase_orders_org_idx: await probes.indexExists("teller_purchase_orders_org_idx"),
    teller_purchase_order_lines_po_idx: await probes.indexExists(
      "teller_purchase_order_lines_po_idx",
    ),
    teller_purchase_receipts_po_idx: await probes.indexExists("teller_purchase_receipts_po_idx"),
    teller_recurring_bill_templates_org_idx: await probes.indexExists(
      "teller_recurring_bill_templates_org_idx",
    ),
  };

  const constraints021 = {
    "teller_parties.teller_parties_party_status_check": await probes.constraintExists(
      "teller_parties",
      "teller_parties_party_status_check",
    ),
    "teller_document_lines.teller_document_lines_cost_type_check": await probes.constraintExists(
      "teller_document_lines",
      "teller_document_lines_cost_type_check",
    ),
    "teller_documents.teller_documents_status_check": await probes.constraintExists(
      "teller_documents",
      "teller_documents_status_check",
    ),
  };
  const constraints022 = {
    "teller_purchase_orders.teller_purchase_orders_number_org": await probes.constraintExists(
      "teller_purchase_orders",
      "teller_purchase_orders_number_org",
    ),
    "teller_purchase_orders.teller_purchase_orders_status_check": await probes.constraintExists(
      "teller_purchase_orders",
      "teller_purchase_orders_status_check",
    ),
    "teller_purchase_receipt_lines.teller_purchase_receipt_lines_qty_positive":
      await probes.constraintExists(
        "teller_purchase_receipt_lines",
        "teller_purchase_receipt_lines_qty_positive",
      ),
    "teller_recurring_bill_templates.teller_recurring_bill_templates_recurrence_check":
      await probes.constraintExists(
        "teller_recurring_bill_templates",
        "teller_recurring_bill_templates_recurrence_check",
      ),
    "teller_documents.teller_documents_purchase_order_id_fkey": await probes.constraintExists(
      "teller_documents",
      "teller_documents_purchase_order_id_fkey",
    ),
  };

  const policies021 = {
    ap_read: await probes.policyExists("teller_ap_settings", "teller members read ap settings"),
    ap_write: await probes.policyExists(
      "teller_ap_settings",
      "teller writers manage ap settings",
    ),
  };
  const policyNames022 = [
    ["teller_purchase_orders", "teller members read purchase orders"],
    ["teller_purchase_orders", "teller writers manage purchase orders"],
    ["teller_purchase_order_lines", "teller members read po lines"],
    ["teller_purchase_order_lines", "teller writers manage po lines"],
    ["teller_purchase_receipts", "teller members read purchase receipts"],
    ["teller_purchase_receipts", "teller writers manage purchase receipts"],
    ["teller_purchase_receipt_lines", "teller members read receipt lines"],
    ["teller_purchase_receipt_lines", "teller writers manage receipt lines"],
    ["teller_recurring_bill_templates", "teller members read recurring bill templates"],
    ["teller_recurring_bill_templates", "teller writers manage recurring bill templates"],
    ["teller_recurring_bill_template_lines", "teller members read recurring template lines"],
    ["teller_recurring_bill_template_lines", "teller writers manage recurring template lines"],
  ];
  const policies022 = Object.fromEntries(
    await Promise.all(
      policyNames022.map(async ([t, n]) => [`${t}.${n}`, await probes.policyExists(t, n)]),
    ),
  );

  const rls022 = Object.fromEntries(
    await Promise.all(TABLES_022.map(async (t) => [t, await probes.rlsEnabled(t)])),
  );

  const countTrue = (obj) => Object.values(obj).filter((v) => v === true).length;
  const countKnown = (obj) => Object.values(obj).filter((v) => v !== null && v !== undefined).length;
  const countKnownTrue = (obj) => Object.values(obj).filter((v) => v === true).length;

  const partiesPresent = countTrue(partiesCols);
  const docLinesPresent = countTrue(docLineCols);
  const docsPresent = countTrue(docCols);
  const tables021Present = countTrue(tables021);
  const tables022Present = countTrue(tables022);

  const total021Tracked =
    COLS_021_PARTIES.length +
    COLS_021_DOC_LINES.length +
    COLS_021_DOCUMENTS.length +
    TABLES_021.length;
  const present021Tracked =
    partiesPresent + docLinesPresent + docsPresent + tables021Present;

  let prod021Status = "absent";
  if (present021Tracked === total021Tracked) prod021Status = "complete";
  else if (present021Tracked > 0) prod021Status = "partial";

  const cols022Expected = TABLES_022.filter((t) => tables022[t]).reduce(
    (s, t) => s + COLS_022[t].length,
    0,
  );
  const cols022Present = cols022Expected - cols022Missing.length;

  let prod022Status = "absent";
  if (tables022Present === 0) prod022Status = "absent";
  else if (
    tables022Present === TABLES_022.length &&
    cols022Missing.length === 0 &&
    (countKnown(indexes022) === 0 || countKnownTrue(indexes022) === 4) &&
    (countKnown(constraints022) === 0 || countKnownTrue(constraints022) === 5) &&
    (countKnown(policies022) === 0 || countKnownTrue(policies022) === 12) &&
    (Object.values(rls022).every((v) => v === null) || Object.values(rls022).every((v) => v === true))
  ) {
    prod022Status = "complete";
  } else {
    prod022Status = "partial";
  }

  const pendingApproval = await probes.statusCheckDef();
  const fkPresent = constraints022["teller_documents.teller_documents_purchase_order_id_fkey"];
  const poColPresent = docCols.purchase_order_id;

  const dependencies = [
    {
      dependency: "teller_documents.purchase_order_id column",
      introduced_in: "021",
      used_by_022: "ALTER TABLE teller_documents ADD CONSTRAINT teller_documents_purchase_order_id_fkey",
      prod_021_column: poColPresent,
      prod_022_fk: fkPresent,
    },
    {
      dependency: "teller_documents status includes pending_approval",
      introduced_in: "021",
      used_by_022: "indirect — bill approval workflow / app code",
      prod_present: pendingApproval,
    },
    {
      dependency: "teller_document_lines job_id / cost_category / cost_type",
      introduced_in: "021",
      used_by_022: "no — 022 PO lines define own columns on teller_purchase_order_lines",
      prod_present: docLineCols,
    },
    {
      dependency: "teller_ap_settings",
      introduced_in: "021",
      used_by_022: "no direct FK/reference in 022 DDL",
      prod_present: tables021.teller_ap_settings,
    },
  ];

  const all022Zero = Object.values(rowCounts022).every((c) => c === 0 || c === null);

  let RECOMMENDED_PLAN = "PLAN_D";
  let reason = "";

  if (prod021Status === "absent" && prod022Status === "absent") {
    RECOMMENDED_PLAN = "PLAN_A";
    reason = "Clean slate — apply 021 then 022 in order.";
  } else if (prod021Status === "absent" && prod022Status === "complete") {
    RECOMMENDED_PLAN = "PLAN_C";
    reason =
      "Anomaly: 022 complete without 021 — likely manual/partial apply or probe false positive; verify via pg_catalog before any apply.";
  } else if (prod021Status === "absent" && prod022Status === "partial") {
    RECOMMENDED_PLAN = "PLAN_A";
    reason =
      "Apply 021 first (adds purchase_order_id), then re-run 022 idempotent DDL to finish FK/policies/indexes.";
  } else if (prod021Status === "partial") {
    RECOMMENDED_PLAN = "PLAN_C";
    reason = "Partial 021 — re-run 021 idempotent statements, then assess 022.";
  } else if (prod021Status === "complete" && prod022Status !== "complete") {
    RECOMMENDED_PLAN = "PLAN_A";
    reason = "021 done; re-run 022 to complete.";
  } else if (prod021Status === "complete" && prod022Status === "complete") {
    RECOMMENDED_PLAN = "PLAN_B";
    reason = "Both migrations appear complete.";
  }

  const inconsistentFk = fkPresent === true && poColPresent === false;
  const SAFE_TO_APPLY_021 =
    prod021Status !== "complete" && !inconsistentFk;

  return {
    PROD_021_STATUS: prod021Status,
    PROD_022_STATUS: prod022Status,
    "021_present_objects": {
      teller_parties_columns: partiesCols,
      teller_document_lines_columns: docLineCols,
      teller_documents_columns: docCols,
      tables: tables021,
      indexes: indexes021,
      constraints: constraints021,
      policies: policies021,
      tracked_present: present021Tracked,
      tracked_expected: total021Tracked,
    },
    "022_present_objects": {
      tables: tables022,
      columns_missing: cols022Missing,
      columns_present_ratio: `${cols022Present}/${cols022Expected}`,
      indexes: indexes022,
      constraints: constraints022,
      policies: policies022,
      rls: rls022,
      tables_present: `${tables022Present}/${TABLES_022.length}`,
    },
    "022_DEPENDS_ON_021": true,
    "022_dependencies_on_021": dependencies,
    "022_PRODUCTION_ROW_COUNTS": rowCounts022,
    all_022_rows_zero: all022Zero,
    pending_approval_status_supported: pendingApproval,
    inconsistent_state_flags: {
      fk_without_po_column: inconsistentFk,
      po_tables_without_021_columns: tables022Present > 0 && prod021Status === "absent",
    },
    SAFE_TO_APPLY_021_analysis: {
      duplicate_columns: "021 uses ADD COLUMN IF NOT EXISTS — safe to re-run",
      status_check: pendingApproval
        ? "pending_approval already in check or selectable"
        : "021 will DROP/ADD teller_documents_status_check — verify no pending_approval bills exist",
      fk_step_in_022: poColPresent
        ? "022 FK step is idempotent (DROP IF EXISTS then ADD)"
        : "021 must add purchase_order_id before 022 FK can succeed",
      row_data_risk: all022Zero ? "All Phase 6 tables empty — low migration risk" : "Phase 6 tables contain rows",
    },
    RECOMMENDED_PLAN,
    RECOMMENDED_PLAN_REASON: reason,
    SAFE_TO_APPLY_021,
    READY_FOR_PHASE6_CONTROLLED_PRODUCTION_MIGRATION:
      prod021Status === "complete" && prod022Status === "complete",
  };
}

async function main() {
  loadControlledProdEnv();
  const dbUrl = process.env.SUPABASE_DB_URL?.trim();

  let result;
  if (dbUrl) {
    assertProductionDbUrl(dbUrl);
    result = await auditViaPg(dbUrl);
  } else {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    result = await auditViaRest(supabase);
  }

  console.log(
    JSON.stringify(
      {
        auditedAt: new Date().toISOString(),
        projectRef: "ypixbxicdecwfafculha",
        auditMode: result.mode,
        limitation: result.limitation ?? null,
        ...result.catalog,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
