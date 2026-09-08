#!/usr/bin/env node
/**
 * Level 4 — full historical release gate.
 * Unit tests + build + all phase demos (parallel). Excludes DB acceptance (run explicitly).
 */
import { spawnSync } from "node:child_process";
import { ALL_DEMO_PHASES, CURRENT_PHASE, PHASE_DEPLOY_AUDIT } from "./test-tier-config.mjs";

function run(label, cmd, args) {
  const started = Date.now();
  const result = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const ms = Date.now() - started;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (output.trim()) process.stdout.write(output);
  return { label, ok: result.status === 0, ms };
}

const started = Date.now();
const steps = [];

steps.push(run("unit_all", "npm", ["test"]));
steps.push(run("build", "npm", ["run", "build"]));

// Sequential demos for full gate — parallel all-phase runs can stress shared DB (see TEST-DEPENDENCY-MAP).
steps.push(
  run("demos_all", "node", ["scripts/run-controlled-demos.mjs", ...ALL_DEMO_PHASES.map(String)]),
);

const audit = PHASE_DEPLOY_AUDIT[CURRENT_PHASE] ?? PHASE_DEPLOY_AUDIT[13];
if (audit) steps.push(run("deploy_audit", "npm", ["run", audit]));

const ok = steps.every((step) => step.ok);
console.log(
  JSON.stringify(
    {
      tier: "full",
      ok,
      elapsedMs: Date.now() - started,
      steps,
      dbAcceptanceExcluded: true,
      note: "Use accept:phaseN:controlled or verify:deploy for DB acceptance at phase gates.",
    },
    null,
    2,
  ),
);

process.exit(ok ? 0 : 1);
