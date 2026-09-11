#!/usr/bin/env node
/**
 * Load MO/KS state tax packs from tax-rules/state-packs/*.json into global reference tables.
 * Manual operator action — requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 * Does NOT activate packs for any organization.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packsDir = path.join(__dirname, "..", "tax-rules", "state-packs");

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function loadPack(supabase, filePath) {
  const spec = JSON.parse(await readFile(filePath, "utf8"));
  if (!spec.packId || !spec.slug || !spec.version) {
    throw new Error(`Invalid state pack file: ${filePath}`);
  }
  if (spec.status !== "reviewed" && spec.status !== "active") {
    throw new Error(`Refusing to load ${spec.packId} with status=${spec.status}`);
  }

  const specHash = createHash("sha256").update(JSON.stringify(spec)).digest("hex");
  const { data: existingSet } = await supabase
    .from("teller_tax_rule_sets")
    .select("id")
    .eq("slug", spec.slug)
    .maybeSingle();

  const setPayload = {
    slug: spec.slug,
    name: spec.name,
    version: spec.version,
    status: spec.status,
    effective_from: spec.effectiveFrom,
    effective_to: spec.effectiveTo ?? null,
    source_documentation: spec.sourceDocumentation ?? "",
    spec_hash: specHash,
    updated_at: new Date().toISOString(),
  };

  let ruleSetId = existingSet?.id;
  if (ruleSetId) {
    const { error } = await supabase.from("teller_tax_rule_sets").update(setPayload).eq("id", ruleSetId);
    if (error) throw new Error(error.message);
  } else {
    const { data, error } = await supabase.from("teller_tax_rule_sets").insert(setPayload).select("id").single();
    if (error) throw new Error(error.message);
    ruleSetId = data.id;
  }

  for (const jurisdiction of spec.jurisdictions ?? []) {
    const { error } = await supabase.from("teller_tax_jurisdictions").upsert(
      {
        jurisdiction_key: jurisdiction.jurisdictionKey,
        name: jurisdiction.name,
        jurisdiction_type: jurisdiction.jurisdictionType ?? "state",
        country: jurisdiction.country ?? "US",
        state: jurisdiction.state ?? null,
        county: jurisdiction.county ?? null,
        city: jurisdiction.city ?? null,
        parent_jurisdiction_key: jurisdiction.parentJurisdictionKey ?? null,
      },
      { onConflict: "jurisdiction_key" },
    );
    if (error) throw new Error(error.message);
  }

  const authorityIds = new Map();
  for (const authority of spec.authorities ?? []) {
    const { data: existing } = await supabase
      .from("teller_tax_authorities")
      .select("id")
      .eq("authority_key", authority.authorityKey)
      .maybeSingle();
    if (existing?.id) {
      authorityIds.set(authority.authorityKey, existing.id);
      continue;
    }
    const { data, error } = await supabase
      .from("teller_tax_authorities")
      .insert({
        authority_key: authority.authorityKey,
        name: authority.name,
        jurisdiction_key: authority.jurisdictionKey,
        admin_level: authority.adminLevel,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    authorityIds.set(authority.authorityKey, data.id);
  }

  await supabase.from("teller_tax_rates").delete().eq("rule_set_id", ruleSetId);
  const rateIds = new Map();
  for (const component of spec.rateComponents ?? []) {
    const rateKey = `${component.jurisdictionKey}:${component.componentType}:${component.effectiveFrom}`;
    if (!rateIds.has(rateKey)) {
      const { data: rateRow, error: rateError } = await supabase
        .from("teller_tax_rates")
        .insert({
          rule_set_id: ruleSetId,
          jurisdiction_key: component.jurisdictionKey,
          rate_percent: component.ratePercent,
          rate_type: "sales_tax",
          effective_from: component.effectiveFrom,
          effective_to: component.effectiveTo ?? null,
          source_citation: component.sourceCitation ?? "",
        })
        .select("id")
        .single();
      if (rateError) throw new Error(rateError.message);
      rateIds.set(rateKey, rateRow.id);
    }

    const { error: componentError } = await supabase.from("teller_tax_rate_components").insert({
      rate_id: rateIds.get(rateKey),
      component_type: component.componentType,
      jurisdiction_key: component.jurisdictionKey,
      authority_id: component.authorityKey ? authorityIds.get(component.authorityKey) ?? null : null,
      rate_percent: component.ratePercent,
      effective_from: component.effectiveFrom,
      effective_to: component.effectiveTo ?? null,
    });
    if (componentError) throw new Error(componentError.message);
  }

  console.log(`Loaded state pack ${spec.packId}@${spec.version}`);
}

async function main() {
  const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const files = (await readdir(packsDir)).filter((name) => name.endsWith(".json"));
  if (!files.length) {
    console.log("No state pack JSON files found.");
    return;
  }
  for (const file of files) {
    await loadPack(supabase, path.join(packsDir, file));
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
