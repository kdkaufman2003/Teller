#!/usr/bin/env node
/** Create Teller Phase 6 Demo org with COA, AP settings (never HFAC). */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";
const DEMO_ORG_NAME = "Teller Phase 6 Demo";

const ACCOUNT_SEEDS = [
  { code: "1000", name: "Operating Checking", type: "asset", subtype: "bank" },
  { code: "1100", name: "Accounts Receivable", type: "asset", subtype: "receivable" },
  { code: "2000", name: "Accounts Payable", type: "liability", subtype: "payable" },
  { code: "2100", name: "Sales Tax Payable", type: "liability", subtype: "tax" },
  { code: "3000", name: "Owner's Equity", type: "equity", subtype: "" },
  { code: "4000", name: "Service Revenue", type: "revenue", subtype: "" },
  { code: "6100", name: "Cost of Goods Sold", type: "expense", subtype: "" },
  { code: "6150", name: "Materials & Supplies", type: "expense", subtype: "" },
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
}

async function seedApSettings(supabase, organizationId) {
  const { data: existing } = await supabase
    .from("teller_ap_settings")
    .select("organization_id")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (existing?.organization_id) return;

  const { error } = await supabase.from("teller_ap_settings").insert({
    organization_id: organizationId,
    require_bill_approval: true,
    bill_approval_threshold: 500,
    require_po_approval: true,
    po_approval_threshold: 1000,
    default_cost_categories: ["material", "subcontractor", "equipment"],
  });
  if (error && !error.message.includes("does not exist")) {
    throw new Error(`AP settings: ${error.message}`);
  }
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
        external_item_id: `phase6-demo-${organizationId.slice(0, 8)}`,
        institution_name: "Phase 6 Demo Manual Bank",
        status: "active",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message || "connection");
    connectionId = data.id;
  }

  const { data: existingBank } = await supabase
    .from("teller_bank_accounts")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("external_account_id", "phase6-demo-checking")
    .maybeSingle();

  if (existingBank?.id) return { connectionId, checkingBankId: existingBank.id };

  const { data, error } = await supabase
    .from("teller_bank_accounts")
    .insert({
      organization_id: organizationId,
      connection_id: connectionId,
      external_account_id: "phase6-demo-checking",
      name: "Phase 6 Demo Checking",
      account_type: "depository",
      account_subtype: "checking",
      gl_account_id: accounts["1000"],
      teller_account_id: accounts["1000"],
      institution_name: "Phase 6 Demo Manual Bank",
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message || "checking bank");
  return { connectionId, checkingBankId: data.id };
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
  setLine("TELLER_PHASE6_DEMO_ORG_ID", demoOrgId);
  setLine("TELLER_CONTROLLED_TEST_ORG_ID", demoOrgId);
  writeFileSync(envPath, content.trim() + "\n");
}

async function main() {
  loadControlledProdEnv();
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST must equal 1");
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const organizationId = await ensureOrg(supabase);
  if (organizationId === HFAC_ORG_ID) throw new Error("Refusing HFAC org");

  await seedAccounts(supabase, organizationId);
  const { data: accountRows } = await supabase
    .from("teller_accounts")
    .select("id, code")
    .eq("organization_id", organizationId);
  const accounts = Object.fromEntries((accountRows ?? []).map((row) => [row.code, row.id]));
  await seedApSettings(supabase, organizationId);
  const { checkingBankId } = await ensureBankSetup(supabase, organizationId, accounts);
  upsertEnvLocal(organizationId);

  console.log(
    JSON.stringify(
      {
        ok: true,
        organizationId,
        name: DEMO_ORG_NAME,
        checkingBankId,
        hfacProtected: HFAC_ORG_ID,
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
