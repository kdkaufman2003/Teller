#!/usr/bin/env node
/** Create Teller Phase 5 Demo org with COA and linked bank accounts (never HFAC). */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";
const DEMO_ORG_NAME = "Teller Phase 5 Demo";

const ACCOUNT_SEEDS = [
  { code: "1000", name: "Operating Checking", type: "asset", subtype: "bank" },
  { code: "1010", name: "Business Savings", type: "asset", subtype: "bank" },
  { code: "1100", name: "Accounts Receivable", type: "asset", subtype: "receivable" },
  { code: "2000", name: "Accounts Payable", type: "liability", subtype: "payable" },
  { code: "2100", name: "Business Credit Card", type: "liability", subtype: "credit_card" },
  { code: "2300", name: "Customer Deposits", type: "liability", subtype: "deposit" },
  { code: "3000", name: "Owner's Equity", type: "equity", subtype: "" },
  { code: "4000", name: "Service Revenue", type: "revenue", subtype: "" },
  { code: "4100", name: "Interest Income", type: "revenue", subtype: "" },
  { code: "6100", name: "Cost of Goods Sold", type: "expense", subtype: "" },
  { code: "6150", name: "Materials & Supplies", type: "expense", subtype: "" },
  { code: "6850", name: "Bad Debt Expense", type: "expense", subtype: "bad_debt" },
];

async function ensureOrg(supabase) {
  const { data: existing } = await supabase
    .from("teller_organizations")
    .select("id, name")
    .eq("name", DEMO_ORG_NAME)
    .maybeSingle();

  if (existing?.id) {
    if (existing.id === HFAC_ORG_ID) throw new Error("Refusing HFAC org");
    return existing.id;
  }

  const { data, error } = await supabase
    .from("teller_organizations")
    .insert({
      name: DEMO_ORG_NAME,
      legal_name: DEMO_ORG_NAME,
      industry_id: "hvac-residential",
      setup_completed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not create demo org");
  return data.id;
}

async function seedAccounts(supabase, organizationId) {
  for (const row of ACCOUNT_SEEDS) {
    const { data: existing } = await supabase
      .from("teller_accounts")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("code", row.code)
      .maybeSingle();
    if (existing?.id) continue;

    const { error } = await supabase.from("teller_accounts").insert({
      organization_id: organizationId,
      code: row.code,
      name: row.name,
      type: row.type,
      subtype: row.subtype,
      industry_tag: "",
      is_system: true,
    });
    if (error) throw new Error(error.message);
  }

  const { data } = await supabase
    .from("teller_accounts")
    .select("id, code")
    .eq("organization_id", organizationId);
  return Object.fromEntries((data ?? []).map((row) => [row.code, row.id]));
}

async function ensureBankSetup(supabase, organizationId, accounts) {
  let connectionId;
  const { data: existingConn } = await supabase
    .from("teller_bank_connections")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("provider", "manual_csv")
    .limit(1)
    .maybeSingle();

  if (existingConn?.id) {
    connectionId = existingConn.id;
  } else {
    const { data, error } = await supabase
      .from("teller_bank_connections")
      .insert({
        organization_id: organizationId,
        provider: "manual_csv",
        external_item_id: `demo-${organizationId.slice(0, 8)}`,
        institution_name: "Demo Manual Bank",
        status: "active",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message || "connection");
    connectionId = data.id;
  }

  const bankDefs = [
    {
      key: "checking",
      name: "Demo Checking",
      external: "demo-checking",
      type: "depository",
      subtype: "checking",
      glCode: "1000",
    },
    {
      key: "savings",
      name: "Demo Savings",
      external: "demo-savings",
      type: "depository",
      subtype: "savings",
      glCode: "1010",
    },
    {
      key: "creditCard",
      name: "Demo Credit Card",
      external: "demo-credit-card",
      type: "credit",
      subtype: "credit card",
      glCode: "2100",
    },
  ];

  const bankIds = {};
  for (const def of bankDefs) {
    const { data: existing } = await supabase
      .from("teller_bank_accounts")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("external_account_id", def.external)
      .maybeSingle();

    if (existing?.id) {
      bankIds[def.key] = existing.id;
      continue;
    }

    const { data, error } = await supabase
      .from("teller_bank_accounts")
      .insert({
        organization_id: organizationId,
        connection_id: connectionId,
        external_account_id: def.external,
        name: def.name,
        account_type: def.type,
        account_subtype: def.subtype,
        gl_account_id: accounts[def.glCode],
        teller_account_id: accounts[def.glCode],
        institution_name: "Demo Manual Bank",
        status: "active",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message || def.key);
    bankIds[def.key] = data.id;
  }

  return { connectionId, bankIds };
}

function upsertEnvLocal(demoOrgId) {
  const envPath = resolve(process.cwd(), ".env.controlled-prod.local");
  let content = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const setLine = (key, value) => {
    const re = new RegExp(`^${key}=.*$`, "m");
    const line = `${key}=${value}`;
    content = re.test(content) ? content.replace(re, line) : `${content.trim()}\n${line}\n`;
  };
  setLine("TELLER_CONTROLLED_PROD_TEST", "1");
  setLine("TELLER_PHASE5_DEMO_ORG_ID", demoOrgId);
  writeFileSync(envPath, content.trim() + "\n");
}

async function main() {
  loadControlledProdEnv();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const organizationId = await ensureOrg(supabase);
  const accounts = await seedAccounts(supabase, organizationId);
  const { connectionId, bankIds } = await ensureBankSetup(supabase, organizationId, accounts);
  upsertEnvLocal(organizationId);

  console.log(
    JSON.stringify(
      {
        ok: true,
        organizationId,
        name: DEMO_ORG_NAME,
        connectionId,
        bankAccounts: bankIds,
        accountCodes: Object.keys(accounts),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
