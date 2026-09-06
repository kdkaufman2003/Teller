#!/usr/bin/env node
/** Post-test HFAC reconciliation vs pre-test snapshot. */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";

async function countOrg(supabase, table, orgId) {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function main() {
  loadControlledProdEnv();
  const snapshotPath = process.argv[2];
  if (!snapshotPath) throw new Error("Usage: reconcile-hfac-post-test.mjs <pre-snapshot.json>");

  const before = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const afterCounts = {
    documents: await countOrg(supabase, "teller_documents", HFAC_ORG_ID),
    payments: await countOrg(supabase, "teller_payments", HFAC_ORG_ID),
    payment_allocations: await countOrg(supabase, "teller_payment_allocations", HFAC_ORG_ID),
    journal_entries: await countOrg(supabase, "teller_journal_entries", HFAC_ORG_ID),
  };

  const testOrgId = process.env.TELLER_CONTROLLED_TEST_ORG_ID;
  const foreignOrgId = process.env.TELLER_CONTROLLED_FOREIGN_ORG_ID;

  const hfacLeakChecks = [];
  if (testOrgId) {
    for (const table of ["teller_payments", "teller_write_offs"]) {
      const { count, error } = await supabase
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("organization_id", HFAC_ORG_ID)
        .neq("organization_id", HFAC_ORG_ID);
      hfacLeakChecks.push({ table, error: error?.message ?? null, count });
    }
  }

  const { data: phase4InHfac } = await supabase
    .from("teller_write_offs")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", HFAC_ORG_ID);

  const economicsUnchanged = Object.keys(afterCounts).every(
    (key) => afterCounts[key] === before.hfac.counts[key],
  );

  console.log(
    JSON.stringify(
      {
        economicsUnchanged,
        before: before.hfac.counts,
        after: afterCounts,
        hfacWriteOffs: phase4InHfac?.length ?? 0,
        testOrgId,
        foreignOrgId,
      },
      null,
      2,
    ),
  );

  if (!economicsUnchanged) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
