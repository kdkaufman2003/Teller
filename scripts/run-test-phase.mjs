#!/usr/bin/env node
/** Level 2 — current phase validation (unit + static verify + logic matrix). */
import { spawnSync } from "node:child_process";
import {
  CURRENT_PHASE,
  PHASE_DEMOS,
  PHASE_UNIT_TESTS,
  PHASE_VERIFY,
  demoPhaseKey,
} from "./test-tier-config.mjs";

const phase = demoPhaseKey(CURRENT_PHASE);
const demo = PHASE_DEMOS[phase];
const verify = PHASE_VERIFY[phase];
const unitPatterns = PHASE_UNIT_TESTS[phase] ?? [`src/lib/accounting/phase${phase}.test.ts`];

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

steps.push(run("unit", "npx", ["vitest", "run", ...unitPatterns]));

if (verify) {
  steps.push(run("verify", "npm", ["run", verify]));
} else {
  steps.push({ label: "verify", ok: true, ms: 0, skipped: true });
}

if (demo) {
  steps.push(run("demo", "npm", ["run", demo.script]));
} else {
  console.error(`No demo configured for phase ${phase}`);
  steps.push({ label: "demo", ok: false, ms: 0 });
}

const ok = steps.every((step) => step.ok);
console.log(
  JSON.stringify(
    {
      tier: "phase",
      phase: CURRENT_PHASE,
      ok,
      elapsedMs: Date.now() - started,
      steps,
      note: "Current phase only — no cross-phase regressions.",
    },
    null,
    2,
  ),
);

process.exit(ok ? 0 : 1);
