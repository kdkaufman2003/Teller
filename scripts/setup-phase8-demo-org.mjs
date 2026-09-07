#!/usr/bin/env node
/** Create Teller Phase 8 Demo org with FA COA, categories, settings (never HFAC). */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";
const DEMO_ORG_NAME = "Teller Phase 8 Demo";
const FOREIGN_ORG_NAME = "Teller Phase 8 Foreign Test";

const BASE_ACCOUNT_SEEDS = [
  { code: "1000", name: "Operating Checking", type: "asset", subtype: "bank" },
  { code: "1100", name: "Accounts Receivable", type: "asset", subtype: "receivable" },
  { code: "2000", name: "Accounts Payable", type: "liability", subtype: "payable" },
  { code: "3000", name: "Owner's Equity", type: "equity", subtype: "" },
  { code: "3900", name: "Opening Balance Equity", type: "equity", subtype: "opening_balance_equity" },
  { code: "1500", name: "Fixed Assets", type: "asset", subtype: "fixed_asset" },
  { code: "1510", name: "Accumulated Depreciation", type: "asset", subtype: "accumulated_depreciation" },
  { code: "6800", name: "Depreciation Expense", type: "expense", subtype: "depreciation_expense" },
  { code: "4900", name: "Gain on Asset Disposal", type: "revenue", subtype: "gain_on_disposal" },
  { code: "6910", name: "Loss on Asset Disposal", type: "expense", subtype: "loss_on_disposal" },
  { code: "6100", name: "Office Expense", type: "expense", subtype: "" },
];

async function ensureOrg(supabase, name) {
  const { data: existing } = await supabase
    .from("teller_organizations")
    .select("id, name")
    .eq("name", name)
    .maybeSingle();
  if (existing?.id) {
    if (existing.id === HFAC_ORG_ID) throw new Error("Refusing HFAC org");
    return existing.id;
  }
  const { data, error } = await supabase
    .from("teller_organizations")
    .insert({
      name,
      legal_name: name,
      industry_id: "general",
      setup_completed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not create demo org");
  return data.id;
}

async function seedAccounts(supabase, organizationId) {
  for (const row of BASE_ACCOUNT_SEEDS) {
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
      subtype: row.subtype ?? "",
      industry_tag: "",
      is_system: true,
    });
    if (error) throw new Error(error.message);
  }
}

async function seedSettings(supabase, organizationId) {
  const modules = [
    "dashboard",
    "invoices",
    "expenses",
    "customers",
    "accounts",
    "ledger",
    "fixed_assets",
    "bills",
    "vendors",
  ];

  const { data: existing } = await supabase
    .from("teller_industry_settings")
    .select("organization_id")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (existing?.organization_id) {
    await supabase
      .from("teller_industry_settings")
      .update({ modules, answers: { trackFixedAssets: true } })
      .eq("organization_id", organizationId);
  } else {
    await supabase.from("teller_industry_settings").insert({
      organization_id: organizationId,
      modules,
      labels: {},
      answers: { trackFixedAssets: true },
    });
  }

  await supabase.from("teller_fixed_asset_settings").upsert({
    organization_id: organizationId,
    capitalization_threshold: 2500,
    depreciation_convention: "full_month",
    rounding_policy: "last_period",
  });
}

async function main() {
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST must equal 1");
  }
  loadControlledProdEnv();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const demoOrgId = await ensureOrg(supabase, DEMO_ORG_NAME);
  const foreignOrgId = await ensureOrg(supabase, FOREIGN_ORG_NAME);
  if (demoOrgId === HFAC_ORG_ID || foreignOrgId === HFAC_ORG_ID) {
    throw new Error("Refusing HFAC org");
  }

  await seedAccounts(supabase, demoOrgId);
  await seedSettings(supabase, demoOrgId);

  const envPath = resolve(process.cwd(), ".env.controlled-prod.local");
  let env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const set = (key, value) => {
    const line = `${key}=${value}`;
    if (env.includes(`${key}=`)) {
      env = env.replace(new RegExp(`^${key}=.*$`, "m"), line);
    } else {
      env += `${env.endsWith("\n") ? "" : "\n"}${line}\n`;
    }
  };
  set("TELLER_PHASE8_DEMO_ORG_ID", demoOrgId);
  set("TELLER_PHASE8_FOREIGN_ORG_ID", foreignOrgId);
  writeFileSync(envPath, env);

  console.log(JSON.stringify({ demoOrgId, foreignOrgId, demoOrgName: DEMO_ORG_NAME }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
