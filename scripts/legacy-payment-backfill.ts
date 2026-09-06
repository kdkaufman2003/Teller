#!/usr/bin/env node
/**
 * Safe idempotent legacy teller_payments backfill from ledger evidence.
 *
 * DRY RUN (default):
 *   ORGANIZATION_ID=<uuid> npm run legacy:payment-backfill
 *
 * APPLY:
 *   ORGANIZATION_ID=<uuid> APPLY=1 npm run legacy:payment-backfill
 */
import "./load-env.mjs";
import { createClient } from "@supabase/supabase-js";
import { backfillLegacyPayments } from "../src/lib/accounting/legacy-payments";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  const organizationId = requiredEnv("ORGANIZATION_ID");
  const dryRun = process.env.APPLY !== "1";

  const supabase = createClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const result = await backfillLegacyPayments(supabase, { organizationId, dryRun });

  console.log(JSON.stringify({ mode: dryRun ? "DRY_RUN" : "APPLY", ...result }, null, 2));

  if (dryRun) {
    console.error("\nDry run only. Re-run with APPLY=1 to insert missing teller_payments rows.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
