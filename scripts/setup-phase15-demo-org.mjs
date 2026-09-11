#!/usr/bin/env node
/** Create Teller Phase 15 Demo org (never HFAC, never other phase demo orgs). */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";
const DEMO_ORG_NAME = "Teller Phase 15 Demo";
const FOREIGN_ORG_NAME = "Teller Phase 15 Foreign Test";

const ACCOUNTS = [
  { code: "2100", name: "Sales Tax Payable", type: "liability", subtype: "tax" },
  { code: "4000", name: "Revenue", type: "revenue", subtype: "" },
  { code: "3000", name: "Opening Balance Equity", type: "equity", subtype: "opening_balance" },
];

const PEER_ENV_KEYS = [
  "TELLER_PHASE5_DEMO_ORG_ID",
  "TELLER_PHASE6_DEMO_ORG_ID",
  "TELLER_PHASE7_DEMO_ORG_ID",
  "TELLER_PHASE8_DEMO_ORG_ID",
  "TELLER_PHASE9_DEMO_ORG_ID",
  "TELLER_PHASE10_DEMO_ORG_ID",
  "TELLER_PHASE11_DEMO_ORG_ID",
  "TELLER_PHASE12_DEMO_ORG_ID",
  "TELLER_PHASE13_DEMO_ORG_ID",
  "TELLER_PHASE14_DEMO_ORG_ID",
];

function assertDistinctFromPeers(orgId) {
  if (orgId === HFAC_ORG_ID) throw new Error("Refusing HFAC org");
  for (const key of PEER_ENV_KEYS) {
    const peer = process.env[key]?.trim();
    if (peer && peer === orgId) throw new Error(`${key} must not equal Phase 15 demo org`);
  }
}

async function ensureOrg(supabase, name) {
  const { data: existing } = await supabase.from("teller_organizations").select("id").eq("name", name).maybeSingle();
  if (existing?.id) {
    assertDistinctFromPeers(existing.id);
    return existing.id;
  }
  const { data, error } = await supabase
    .from("teller_organizations")
    .insert({ name, legal_name: name, industry_id: "general", setup_completed_at: new Date().toISOString() })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not create org");
  assertDistinctFromPeers(data.id);
  return data.id;
}

async function seedAccounts(supabase, orgId) {
  for (const row of ACCOUNTS) {
    const { data: existing } = await supabase
      .from("teller_accounts")
      .select("id")
      .eq("organization_id", orgId)
      .eq("code", row.code)
      .maybeSingle();
    if (existing?.id) continue;
    const { error } = await supabase.from("teller_accounts").insert({
      organization_id: orgId,
      code: row.code,
      name: row.name,
      type: row.type,
      subtype: row.subtype,
      industry_tag: row.subtype === "tax" ? "tax" : "",
      is_system: true,
    });
    if (error) throw new Error(error.message);
  }
}

function patchEnvFile(orgId, foreignOrgId) {
  const envPath = resolve(process.cwd(), ".env.controlled-prod.local");
  let content = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  for (const [key, value] of [
    ["TELLER_PHASE15_DEMO_ORG_ID", orgId],
    ["TELLER_PHASE15_FOREIGN_ORG_ID", foreignOrgId],
  ]) {
    const line = `${key}=${value}`;
    if (content.includes(`${key}=`)) {
      content = content.replace(new RegExp(`^${key}=.*$`, "m"), line);
    } else {
      if (content.length && !content.endsWith("\n")) content += "\n";
      content += line + "\n";
    }
  }
  writeFileSync(envPath, content);
}

async function main() {
  loadControlledProdEnv();
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST=1 required");
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase env missing");
  const supabase = createClient(url, key);

  const orgId = await ensureOrg(supabase, DEMO_ORG_NAME);
  const foreignOrgId = await ensureOrg(supabase, FOREIGN_ORG_NAME);
  await seedAccounts(supabase, orgId);
  await seedAccounts(supabase, foreignOrgId);
  patchEnvFile(orgId, foreignOrgId);

  console.log(JSON.stringify({ ok: true, orgId, foreignOrgId, orgName: DEMO_ORG_NAME }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
