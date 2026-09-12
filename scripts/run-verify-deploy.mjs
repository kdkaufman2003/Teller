#!/usr/bin/env node
/**
 * Release deploy verification — required gates only.
 * Does NOT run full historical demos or DB acceptance unless TELLER_INCLUDE_DB_ACCEPTANCE=1.
 */
import { spawnSync } from "node:child_process";
import { CURRENT_PHASE, DB_ACCEPTANCE_SCRIPTS, PHASE_DEPLOY_AUDIT } from "./test-tier-config.mjs";

function run(label, cmd, args) {
  const started = Date.now();
  const result = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const ms = Date.now() - started;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (output.trim()) process.stdout.write(output);
  return { label, ok: result.status === 0, ms };
}

const phase = CURRENT_PHASE;
const started = Date.now();
const steps = [];

steps.push(run("unit_all", "npm", ["test"]));
steps.push(run("build", "npm", ["run", "build"]));
steps.push(run("phase_logic", "node", ["scripts/run-test-phase.mjs"]));

const audit = PHASE_DEPLOY_AUDIT[phase] ?? PHASE_DEPLOY_AUDIT[13];
if (audit) steps.push(run("deploy_audit", "npm", ["run", audit]));

if (phase === 13) {
  steps.push(run("verify_migration_031", "npm", ["run", "verify:migration:031:controlled"]));
  steps.push(run("verify_grni_patch", "npm", ["run", "verify:grni-settle-rpc-patch:controlled"]));
}

if (phase === 16) {
  steps.push(run("verify_phase16_multi_entity", "npm", ["run", "verify:phase16:multi-entity"]));
  steps.push(run("verify_migration_040", "npm", ["run", "verify:migration:040:controlled"]));
}

if (phase === 15) {
  steps.push(run("verify_phase15_tax", "npm", ["run", "verify:phase15:tax"]));
  steps.push(run("verify_migration_035", "npm", ["run", "verify:migration:035:controlled"]));
  steps.push(run("verify_migration_037", "npm", ["run", "verify:migration:037:controlled"]));
  steps.push(run("verify_migration_038", "npm", ["run", "verify:migration:038:controlled"]));
}

if (process.env.TELLER_INCLUDE_DB_ACCEPTANCE === "1") {
  const accept = DB_ACCEPTANCE_SCRIPTS[phase] ?? DB_ACCEPTANCE_SCRIPTS[13];
  if (accept) steps.push(run("db_acceptance", "npm", ["run", accept]));
}

const ok = steps.every((step) => step.ok);
console.log(
  JSON.stringify(
    {
      tier: "verify_deploy",
      phase,
      ok,
      elapsedMs: Date.now() - started,
      steps,
      dbAcceptanceIncluded: process.env.TELLER_INCLUDE_DB_ACCEPTANCE === "1",
      manualMigrationRule: "Schema changes are never auto-applied",
    },
    null,
    2,
  ),
);

process.exit(ok ? 0 : 1);
