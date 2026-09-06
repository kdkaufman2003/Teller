#!/usr/bin/env node
/** Delete controlled test orgs by exact name match only. */
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";
const ALLOWED_NAMES = new Set(["Teller Phase 4 Test", "Teller Phase 4 Foreign Test"]);

async function main() {
  loadControlledProdEnv({ requireTestOrg: true });
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const removed = [];
  for (const name of ALLOWED_NAMES) {
    const { data } = await supabase
      .from("teller_organizations")
      .select("id, name")
      .eq("name", name)
      .maybeSingle();
    if (!data?.id) continue;
    if (data.id === HFAC_ORG_ID) {
      throw new Error(`Refusing to delete HFAC org matched by name ${name}`);
    }
    const { error } = await supabase.from("teller_organizations").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    removed.push({ id: data.id, name: data.name });
  }

  console.log(JSON.stringify({ ok: true, removed }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
