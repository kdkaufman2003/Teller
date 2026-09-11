#!/usr/bin/env node

import "./load-env.mjs";
import { createClient } from "@supabase/supabase-js";

const organizationId = process.env.ORGANIZATION_ID?.trim();
const externalId =
  process.env.HFAC_COMPANY_ID?.trim() || "a1000000-0000-4000-8000-000000000001";

if (!organizationId) {
  console.error("Set ORGANIZATION_ID to the Teller org UUID (HFAC TELLER_ORGANIZATION_ID).");
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: integration, error } = await supabase
  .from("teller_integrations")
  .select("config")
  .eq("organization_id", organizationId)
  .eq("provider", "hfac")
  .maybeSingle();

if (error) {
  console.error(error.message);
  process.exit(1);
}
if (!integration) {
  console.error("HFAC integration record not found for organization", organizationId);
  process.exit(1);
}

const config =
  integration.config && typeof integration.config === "object" ? integration.config : {};

const { error: updateError } = await supabase
  .from("teller_integrations")
  .update({
    enabled: true,
    config: {
      ...config,
      external_account_id: externalId,
      hfac_company_id: externalId,
      status: "active",
    },
    updated_at: new Date().toISOString(),
  })
  .eq("organization_id", organizationId)
  .eq("provider", "hfac");

if (updateError) {
  console.error(updateError.message);
  process.exit(1);
}

console.log(
  JSON.stringify({ ok: true, organizationId, externalAccountId: externalId }, null, 2),
);
