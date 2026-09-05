#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";

function configExternalId(config) {
  if (!config || typeof config !== "object") return null;
  const row = config;
  const candidates = [row.external_account_id, row.hfac_company_id, row.company_id];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: integrations, error } = await supabase
    .from("teller_integrations")
    .select("organization_id, provider, enabled, config")
    .in("provider", ["hfac", "hasslefreeac"]);

  if (error) {
    console.error(error.message);
    process.exit(1);
  }

  const orgIds = [...new Set((integrations ?? []).map((row) => row.organization_id))];
  const { data: orgs } = orgIds.length
    ? await supabase.from("teller_organizations").select("id, name").in("id", orgIds)
    : { data: [] };

  const orgNames = new Map((orgs ?? []).map((row) => [row.id, row.name]));

  const rows = (integrations ?? [])
    .filter((row) => row.provider === "hfac" || row.provider === "hasslefreeac")
    .map((row) => {
      const externalAccountId = configExternalId(row.config);
      const status = !row.enabled
        ? "inactive"
        : externalAccountId
          ? "active"
          : "invalid";
      const mapping = !row.enabled
        ? "inactive"
        : externalAccountId
          ? "mapped"
          : "unmapped";
      return {
        organizationId: row.organization_id,
        organizationName: orgNames.get(row.organization_id) ?? null,
        provider: row.provider,
        enabled: Boolean(row.enabled),
        status,
        externalAccountId,
        mapping,
      };
    });

  const externalToOrgs = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.externalAccountId || row.mapping !== "mapped") continue;
    const list = externalToOrgs.get(row.externalAccountId) ?? [];
    list.push(row.organizationId);
    externalToOrgs.set(row.externalAccountId, list);
  }

  const duplicateExternalMappings = [...externalToOrgs.entries()]
    .filter(([, orgsForExternal]) => orgsForExternal.length > 1)
    .map(([externalAccountId, organizationIds]) => ({
      externalAccountId,
      organizationIds,
      severity: "CRITICAL",
    }));

  const summary = {
    total: rows.length,
    active: rows.filter((row) => row.status === "active").length,
    inactive: rows.filter((row) => row.status === "inactive").length,
    mapped: rows.filter((row) => row.mapping === "mapped").length,
    unmapped: rows.filter((row) => row.mapping === "unmapped").length,
    invalid: rows.filter((row) => row.status === "invalid").length,
    duplicateExternalMappings: duplicateExternalMappings.length,
  };

  console.log(
    JSON.stringify({ summary, duplicateExternalMappings, rows }, null, 2),
  );

  if (summary.unmapped > 0 || duplicateExternalMappings.length > 0) {
    console.error(
      `\nMigration blockers: unmapped=${summary.unmapped}, duplicateExternalMappings=${duplicateExternalMappings.length}`,
    );
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
