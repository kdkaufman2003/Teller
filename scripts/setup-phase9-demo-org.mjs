#!/usr/bin/env node
/** Create Teller Phase 9 Demo org with prepaid/accrued COA (never HFAC). */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";
const DEMO_ORG_NAME = "Teller Phase 9 Demo";
const FOREIGN_ORG_NAME = "Teller Phase 9 Foreign Test";

const BASE_ACCOUNT_SEEDS = [
  { code: "1000", name: "Operating Checking", type: "asset", subtype: "bank" },
  { code: "1100", name: "Accounts Receivable", type: "asset", subtype: "receivable" },
  { code: "1300", name: "Prepaid Expenses", type: "asset", subtype: "prepaid" },
  { code: "2000", name: "Accounts Payable", type: "liability", subtype: "payable" },
  { code: "2100", name: "Accrued Expenses", type: "liability", subtype: "accrued" },
  { code: "3000", name: "Owner's Equity", type: "equity", subtype: "" },
  { code: "3900", name: "Opening Balance Equity", type: "equity", subtype: "opening_balance_equity" },
  { code: "4000", name: "Service Revenue", type: "revenue", subtype: "" },
  { code: "6100", name: "Office Expense", type: "expense", subtype: "" },
  { code: "6200", name: "Insurance Expense", type: "expense", subtype: "" },
  { code: "6300", name: "Payroll Expense", type: "expense", subtype: "" },
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
    "bills",
    "vendors",
    "accounting",
  ];

  const { data: existing } = await supabase
    .from("teller_industry_settings")
    .select("organization_id")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (existing?.organization_id) {
    await supabase
      .from("teller_industry_settings")
      .update({
        modules,
        answers: { fiscalYearStart: 1, basis: "accrual" },
      })
      .eq("organization_id", organizationId);
  } else {
    await supabase.from("teller_industry_settings").insert({
      organization_id: organizationId,
      modules,
      labels: {},
      answers: { fiscalYearStart: 1, basis: "accrual" },
    });
  }

  await supabase.from("teller_close_settings").upsert({
    organization_id: organizationId,
    adjustment_approval_required: false,
    warnings_require_acknowledgment: false,
    required_bank_account_ids: [],
  });
}

function writeEnvKeys(filename, keys) {
  const envPath = resolve(process.cwd(), filename);
  let env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  for (const [key, value] of Object.entries(keys)) {
    const line = `${key}=${value}`;
    if (env.includes(`${key}=`)) {
      env = env.replace(new RegExp(`^${key}=.*$`, "m"), line);
    } else {
      env += `${env.endsWith("\n") ? "" : "\n"}${line}\n`;
    }
  }
  writeFileSync(envPath, env);
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

  const envKeys = {
    TELLER_PHASE9_DEMO_ORG_ID: demoOrgId,
    TELLER_PHASE9_FOREIGN_ORG_ID: foreignOrgId,
  };
  writeEnvKeys(".env.integration", envKeys);
  writeEnvKeys(".env.controlled-prod.local", envKeys);

  console.log(JSON.stringify({ demoOrgId, foreignOrgId, demoOrgName: DEMO_ORG_NAME }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
