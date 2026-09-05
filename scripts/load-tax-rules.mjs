#!/usr/bin/env node
/**
 * Load reviewed/active tax rule sets from tax-rules/active/*.json into Supabase.
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 *
 * Authoritative MO/KS rules are NOT shipped here — add spec files after review.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const activeDir = path.join(root, "tax-rules", "active");
const allowDraft = process.argv.includes("--allow-draft");

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validateRuleSet(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Rule set must be an object");
  const required = ["slug", "name", "version", "status", "effectiveFrom", "rules"];
  for (const key of required) {
    if (!raw[key]) throw new Error(`Missing required field: ${key}`);
  }
  if (!Array.isArray(raw.rules) || !raw.rules.length) {
    throw new Error("Rule set must include rules[]");
  }
  const allowed = allowDraft
    ? ["draft", "reviewed", "active", "retired"]
    : ["reviewed", "active", "retired"];
  if (!allowed.includes(raw.status)) {
    throw new Error(
      `Refusing to load ${raw.slug} with status=${raw.status}. Review and set status to reviewed/active first.`,
    );
  }
  return raw;
}

async function loadFile(supabase, filePath) {
  const raw = JSON.parse(await readFile(filePath, "utf8"));
  const spec = validateRuleSet(raw);
  const specHash = createHash("sha256").update(JSON.stringify(spec)).digest("hex");

  const { data: existing } = await supabase
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

  let ruleSetId = existing?.id;
  if (ruleSetId) {
    const { error } = await supabase
      .from("teller_tax_rule_sets")
      .update(setPayload)
      .eq("id", ruleSetId);
    if (error) throw new Error(error.message);
  } else {
    const { data, error } = await supabase
      .from("teller_tax_rule_sets")
      .insert(setPayload)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    ruleSetId = data.id;
  }

  for (const jurisdiction of spec.jurisdictions ?? []) {
    const { error } = await supabase.from("teller_tax_jurisdictions").upsert(
      {
        jurisdiction_key: jurisdiction.jurisdictionKey,
        name: jurisdiction.name,
        country: jurisdiction.country ?? "US",
        state: jurisdiction.state ?? null,
        county: jurisdiction.county ?? null,
        city: jurisdiction.city ?? null,
      },
      { onConflict: "jurisdiction_key" },
    );
    if (error) throw new Error(error.message);
  }

  await supabase.from("teller_tax_rules").delete().eq("rule_set_id", ruleSetId);
  await supabase.from("teller_tax_rates").delete().eq("rule_set_id", ruleSetId);

  if (spec.rules?.length) {
    const { error } = await supabase.from("teller_tax_rules").insert(
      spec.rules.map((rule) => ({
        rule_set_id: ruleSetId,
        rule_key: rule.ruleKey,
        priority: rule.priority ?? 100,
        conditions: rule.conditions ?? {},
        action: rule.action,
      })),
    );
    if (error) throw new Error(error.message);
  }

  if (spec.rates?.length) {
    const { error } = await supabase.from("teller_tax_rates").insert(
      spec.rates.map((rate) => ({
        rule_set_id: ruleSetId,
        jurisdiction_key: rate.jurisdictionKey,
        rate_percent: rate.ratePercent,
        rate_type: rate.rateType ?? "sales_tax",
        effective_from: rate.effectiveFrom,
        effective_to: rate.effectiveTo ?? null,
        source_citation: rate.sourceCitation ?? "",
      })),
    );
    if (error) throw new Error(error.message);
  }

  console.log(`Loaded ${spec.slug}@${spec.version} (${spec.status})`);
}

async function main() {
  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  let files = [];
  try {
    files = (await readdir(activeDir)).filter((name) => name.endsWith(".json"));
  } catch {
    console.log("No tax-rules/active directory or no JSON files — nothing to load.");
    return;
  }

  if (!files.length) {
    console.log("No rule set files in tax-rules/active — engine will use flat-rate fallback.");
    return;
  }

  for (const file of files) {
    await loadFile(supabase, path.join(activeDir, file));
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
