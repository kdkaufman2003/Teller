#!/usr/bin/env node
/** Create controlled test organizations (never HFAC). */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";
const TEST_ORG_NAME = "Teller Phase 4 Test";
const FOREIGN_ORG_NAME = "Teller Phase 4 Foreign Test";

const ACCOUNT_SEEDS = [
  { code: "1000", name: "Operating Bank Account", type: "asset", subtype: "bank" },
  { code: "1100", name: "Accounts Receivable", type: "asset", subtype: "receivable" },
  { code: "2000", name: "Accounts Payable", type: "liability", subtype: "payable" },
  { code: "2300", name: "Customer Deposits", type: "liability", subtype: "deposit" },
  { code: "4000", name: "Service Revenue", type: "revenue", subtype: "" },
  { code: "6100", name: "Cost of Goods Sold", type: "expense", subtype: "" },
  { code: "6150", name: "Materials & Supplies", type: "expense", subtype: "" },
  { code: "6850", name: "Bad Debt Expense", type: "expense", subtype: "bad_debt" },
];

async function ensureOrg(supabase, name) {
  const { data: existing } = await supabase
    .from("teller_organizations")
    .select("id, name")
    .eq("name", name)
    .maybeSingle();

  if (existing?.id) {
    if (existing.id === HFAC_ORG_ID) throw new Error(`Refusing HFAC org for ${name}`);
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
  if (error || !data) throw new Error(error?.message || `Could not create ${name}`);
  if (data.id === HFAC_ORG_ID) throw new Error("Created org id matches HFAC — abort");
  return data.id;
}

async function seedAccounts(supabase, organizationId) {
  const { count } = await supabase
    .from("teller_accounts")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);
  if ((count ?? 0) >= ACCOUNT_SEEDS.length) return;

  const { error } = await supabase.from("teller_accounts").insert(
    ACCOUNT_SEEDS.map((row) => ({
      organization_id: organizationId,
      code: row.code,
      name: row.name,
      type: row.type,
      subtype: row.subtype,
      industry_tag: "",
      is_system: true,
    })),
  );
  if (error && !error.message.includes("duplicate")) throw new Error(error.message);
}

function upsertEnvLocal(testOrgId, foreignOrgId) {
  const envPath = resolve(process.cwd(), ".env.controlled-prod.local");
  let content = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const setLine = (key, value) => {
    const re = new RegExp(`^${key}=.*$`, "m");
    const line = `${key}=${value}`;
    content = re.test(content) ? content.replace(re, line) : `${content.trim()}\n${line}\n`;
  };
  setLine("TELLER_CONTROLLED_PROD_TEST", "1");
  setLine("TELLER_CONTROLLED_TEST_ORG_ID", testOrgId);
  setLine("TELLER_CONTROLLED_FOREIGN_ORG_ID", foreignOrgId);
  writeFileSync(envPath, content.trim() + "\n");
}

async function main() {
  loadControlledProdEnv();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const testOrgId = await ensureOrg(supabase, TEST_ORG_NAME);
  const foreignOrgId = await ensureOrg(supabase, FOREIGN_ORG_NAME);
  await seedAccounts(supabase, testOrgId);
  await seedAccounts(supabase, foreignOrgId);
  upsertEnvLocal(testOrgId, foreignOrgId);

  console.log(
    JSON.stringify(
      {
        ok: true,
        testOrg: { id: testOrgId, name: TEST_ORG_NAME },
        foreignOrg: { id: foreignOrgId, name: FOREIGN_ORG_NAME },
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
