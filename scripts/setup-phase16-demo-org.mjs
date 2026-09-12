#!/usr/bin/env node
/** Phase 16A controlled demo org — legal entity acceptance only (never HFAC). */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";
import {
  ensurePhase16RestrictedProfile,
  resetPhase16RestrictedAccessState,
} from "./phase16-controlled-fixture.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";
const DEMO_ORG_NAME = "Teller Phase 16 Demo";
const FOREIGN_ORG_NAME = "Teller Phase 16 Foreign Test";

function setLine(key, value) {
  const envPath = resolve(process.cwd(), ".env.controlled-prod.local");
  let content = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const line = `${key}=${value}`;
  if (content.includes(`${key}=`)) {
    content = content
      .split("\n")
      .map((row) => (row.startsWith(`${key}=`) ? line : row))
      .join("\n");
  } else {
    content = `${content.trim()}\n${line}\n`;
  }
  writeFileSync(envPath, content);
}

async function ensureOrg(supabase, name) {
  const { data: existing } = await supabase
    .from("teller_organizations")
    .select("id")
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
  if (error || !data) throw new Error(error?.message || "Could not create org");
  return data.id;
}

async function main() {
  loadControlledProdEnv();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const demoOrgId = await ensureOrg(supabase, DEMO_ORG_NAME);
  const foreignOrgId = await ensureOrg(supabase, FOREIGN_ORG_NAME);

  const { error: schemaError } = await supabase.from("teller_legal_entities").select("id").limit(1);
  if (schemaError?.message.match(/does not exist|schema cache/i)) {
    throw new Error("Migration 040 not applied — apply manually before setup");
  }

  await supabase.rpc("teller_seed_default_legal_entity", { p_org_id: demoOrgId });
  await supabase.rpc("teller_seed_default_legal_entity", { p_org_id: foreignOrgId });

  const restrictedProfileId = await ensurePhase16RestrictedProfile(supabase, demoOrgId);
  await resetPhase16RestrictedAccessState(supabase, demoOrgId, restrictedProfileId);

  setLine("TELLER_PHASE16_DEMO_ORG_ID", demoOrgId);
  setLine("TELLER_PHASE16_FOREIGN_ORG_ID", foreignOrgId);
  setLine("TELLER_PHASE16_RESTRICTED_PROFILE_ID", restrictedProfileId);

  console.log(
    JSON.stringify(
      {
        ok: true,
        TELLER_PHASE16_DEMO_ORG_ID: demoOrgId,
        TELLER_PHASE16_FOREIGN_ORG_ID: foreignOrgId,
        TELLER_PHASE16_RESTRICTED_PROFILE_ID: restrictedProfileId,
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
