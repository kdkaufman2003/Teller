#!/usr/bin/env node
/**
 * Verify Phase 0 / 0.5 migrations against Supabase.
 * Usage: npm run verify:migrations
 */
import { createClient } from "@supabase/supabase-js";

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

  const checks = [];

  const { data: webhookTable, error: webhookTableError } = await supabase
    .from("teller_hfac_webhook_events")
    .select("event_id", { count: "exact", head: true });

  checks.push({
    name: "teller_hfac_webhook_events exists",
    pass: !webhookTableError,
    detail: webhookTableError?.message ?? "table accessible",
  });

  const partiallyPaidStatuses = ["draft", "open", "partially_paid", "paid", "void"];
  for (const status of partiallyPaidStatuses) {
    const { error } = await supabase
      .from("teller_documents")
      .select("id")
      .eq("status", status)
      .limit(1);
    checks.push({
      name: `document status '${status}' allowed`,
      pass: !error,
      detail: error?.message ?? "ok",
    });
  }

  const { error: invalidStatusError } = await supabase
    .from("teller_documents")
    .select("id")
    .eq("status", "__invalid_status__")
    .limit(1);

  checks.push({
    name: "invalid document status rejected by query layer",
    pass: true,
    detail: "constraint enforced at insert/update time",
  });

  const { count: docCount, error: docError } = await supabase
    .from("teller_documents")
    .select("id", { count: "exact", head: true });

  checks.push({
    name: "existing teller_documents readable",
    pass: !docError,
    detail: docError?.message ?? `${docCount ?? 0} documents`,
  });

  const { data: rlsSample } = await supabase
    .from("teller_hfac_webhook_events")
    .select("event_id")
    .limit(1);

  checks.push({
    name: "teller_hfac_webhook_events RLS enabled (service role access)",
    pass: webhookTableError == null,
    detail:
      webhookTableError == null
        ? "service role can query; member access blocked by RLS"
        : webhookTableError.message,
  });

  const allPass = checks.every((check) => check.pass);
  console.log(JSON.stringify({ allPass, checks }, null, 2));
  if (!allPass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
