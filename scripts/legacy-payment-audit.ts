#!/usr/bin/env node
/**
 * Read-only legacy payment audit across all organizations or one org.
 * Usage:
 *   npm run legacy:payment-audit
 *   ORGANIZATION_ID=<uuid> npm run legacy:payment-audit
 */
import "./load-env.mjs";
import { createClient } from "@supabase/supabase-js";
import {
  auditLegacyPayments,
  reconcileSubledgerToControl,
} from "../src/lib/accounting/legacy-payments";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  const supabase = createClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const organizationId = process.env.ORGANIZATION_ID?.trim() || undefined;
  const audit = await auditLegacyPayments(supabase, organizationId);

  let subledger = [];
  if (organizationId) {
    subledger = await reconcileSubledgerToControl(supabase, organizationId);
  }

  const flagged = audit.rows.filter((row) => row.classification !== "CONSISTENT");

  console.log(
    JSON.stringify(
      {
        organizationId: organizationId ?? "ALL",
        summary: {
          total: audit.total,
          byClassification: audit.byClassification,
          flagged: flagged.length,
        },
        subledgerReconciliation: subledger,
        flaggedRows: flagged,
      },
      null,
      2,
    ),
  );

  if (flagged.length > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
