#!/usr/bin/env node
/** Verify migration 045 + patch on controlled production (read-only probe). */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const M045 = resolve(process.cwd(), "supabase/migrations/045_phase16e_intercompany_settlement.sql");
const PATCH = resolve(process.cwd(), "supabase/patches/045_phase16e_reconciliation_immutable_fix.sql");

async function main() {
  loadControlledProdEnv();
  const issues = [];

  if (!existsSync(M045)) issues.push("Missing migration file 045");
  if (!existsSync(PATCH)) issues.push("Missing patch file 045 reconciliation fix");

  const sql = existsSync(M045) ? readFileSync(M045, "utf8") : "";
  for (const token of [
    "teller_intercompany_settlements",
    "teller_atomic_post_intercompany_settlement",
    "teller_intercompany_pair_reconciliation",
  ]) {
    if (!sql.includes(token)) issues.push(`045 static missing: ${token}`);
  }

  if (!sql.includes("max(combined.transaction_date)")) {
    issues.push("045 migration source should use max(combined.transaction_date) — patch required on applied DB");
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  for (const table of ["teller_intercompany_settlements", "teller_intercompany_settlement_allocations"]) {
    const { error } = await supabase.from(table).select("id").limit(1);
    if (error?.message.match(/does not exist|schema cache/i)) {
      issues.push(`${table} missing on production`);
    }
  }

  const orgId = process.env.TELLER_PHASE16_DEMO_ORG_ID?.trim();
  if (orgId) {
    const { data: entities } = await supabase
      .from("teller_legal_entities")
      .select("id, entity_code")
      .eq("organization_id", orgId)
      .in("entity_code", ["MAIN", "BR16B"]);
    const entityA = entities?.find((e) => e.entity_code === "MAIN")?.id;
    const entityB = entities?.find((e) => e.entity_code === "BR16B")?.id;
    if (entityA && entityB) {
      const { data, error } = await supabase.rpc("teller_intercompany_pair_reconciliation", {
        p_organization_id: orgId,
        p_entity_a_id: entityA,
        p_entity_b_id: entityB,
        p_as_of: new Date().toISOString().slice(0, 10),
      });
      if (error) {
        issues.push(`teller_intercompany_pair_reconciliation probe failed: ${error.message}`);
      } else if (!data?.status) {
        issues.push("reconciliation RPC returned unexpected payload");
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        MIGRATION_045_CONTROLLED_VERIFY: issues.length ? "FAIL" : "PASS",
        PATCH_045_RECONCILIATION_FIX_REQUIRED: issues.some((i) => i.includes("reconciliation"))
          ? true
          : false,
        issues,
        migrationFile: "supabase/migrations/045_phase16e_intercompany_settlement.sql",
        patchFile: "supabase/patches/045_phase16e_reconciliation_immutable_fix.sql",
        automaticMigrationApplication: false,
      },
      null,
      2,
    ),
  );

  process.exit(issues.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
