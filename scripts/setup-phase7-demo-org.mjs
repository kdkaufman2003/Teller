#!/usr/bin/env node
/** Create Teller Phase 7 Demo org with COA, AP settings, job cost categories (never HFAC). */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";
const DEMO_ORG_NAME = "Teller Phase 7 Demo";
const FOREIGN_ORG_NAME = "Teller Phase 7 Foreign Test";

const ACCOUNT_SEEDS = [
  { code: "1000", name: "Operating Checking", type: "asset", subtype: "bank" },
  { code: "1100", name: "Accounts Receivable", type: "asset", subtype: "receivable" },
  { code: "2000", name: "Accounts Payable", type: "liability", subtype: "payable" },
  { code: "2100", name: "Sales Tax Payable", type: "liability", subtype: "tax" },
  { code: "2300", name: "Customer Deposits", type: "liability", subtype: "deposit" },
  { code: "3000", name: "Owner's Equity", type: "equity", subtype: "" },
  { code: "4000", name: "Service Revenue", type: "revenue", subtype: "" },
  { code: "5000", name: "Equipment Cost", type: "cogs", subtype: "" },
  { code: "6100", name: "Cost of Goods Sold", type: "expense", subtype: "" },
  { code: "6150", name: "Materials & Supplies", type: "expense", subtype: "" },
];

const HVAC_CATEGORIES = [
  { code: "equipment", name: "Equipment", category_type: "equipment", sort_order: 10 },
  { code: "materials", name: "Materials", category_type: "material", sort_order: 20 },
  { code: "labor", name: "Labor", category_type: "labor", sort_order: 30 },
  { code: "subcontractors", name: "Subcontractors", category_type: "subcontract", sort_order: 40 },
  { code: "other_direct", name: "Other Direct Cost", category_type: "other", sort_order: 90 },
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
  await supabase.from("teller_ap_settings").insert({
    organization_id: organizationId,
    require_bill_approval: false,
    require_po_approval: false,
    default_cost_categories: ["material", "labor", "subcontractor"],
  });
}

async function seedJobCategories(supabase, organizationId) {
  for (const row of HVAC_CATEGORIES) {
    const { data: existing } = await supabase
      .from("teller_job_cost_categories")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("code", row.code)
      .maybeSingle();
    if (existing?.id) continue;
    await supabase.from("teller_job_cost_categories").insert({
      organization_id: organizationId,
      ...row,
      active: true,
    });
  }
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
  setLine("TELLER_PHASE7_DEMO_ORG_ID", demoOrgId);
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
  const organizationId = await ensureOrg(supabase, DEMO_ORG_NAME);
  await ensureOrg(supabase, FOREIGN_ORG_NAME);
  await seedAccounts(supabase, organizationId);
  await seedApSettings(supabase, organizationId);
  await seedJobCategories(supabase, organizationId);
  upsertEnvLocal(organizationId);
  console.log(JSON.stringify({ ok: true, organizationId, name: DEMO_ORG_NAME, hfacProtected: HFAC_ORG_ID }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
