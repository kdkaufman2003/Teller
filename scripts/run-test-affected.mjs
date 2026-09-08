#!/usr/bin/env node
/** Level 3 — current phase + dependency-aware regressions (parallel demos when safe). */
import { spawnSync } from "node:child_process";
import { CURRENT_PHASE, resolveAffectedDemoPhases, resolveAffectedUnitPatterns } from "./test-tier-config.mjs";

const phase = CURRENT_PHASE;
const demoPhases = resolveAffectedDemoPhases(phase);
const unitPatterns = resolveAffectedUnitPatterns(phase);
const parallel = process.env.TELLER_DEMO_PARALLEL !== "0";

function runUnit() {
  const started = Date.now();
  const result = spawnSync("npx", ["vitest", "run", ...unitPatterns], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (output.trim()) process.stdout.write(output);
  return { label: "unit", ok: result.status === 0, ms: Date.now() - started, patterns: unitPatterns.length };
}

const started = Date.now();
const unitStep = runUnit();

const demoArgs = ["scripts/run-controlled-demos.mjs", ...demoPhases.map(String)];
if (parallel) process.env.TELLER_DEMO_PARALLEL = "1";
const demoStarted = Date.now();
const demoResult = spawnSync("node", demoArgs, {
  env: process.env,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const demoOutput = `${demoResult.stdout ?? ""}${demoResult.stderr ?? ""}`;
if (demoOutput.trim()) process.stdout.write(demoOutput);

const ok = unitStep.ok && demoResult.status === 0;
console.log(
  JSON.stringify(
    {
      tier: "affected",
      phase,
      ok,
      elapsedMs: Date.now() - started,
      demoPhases,
      demoMode: parallel ? "parallel" : "sequential",
      steps: [
        unitStep,
        { label: "demos", ok: demoResult.status === 0, ms: Date.now() - demoStarted },
      ],
      note: "Dependency-aware — skips unrelated phases (e.g. fixed assets, payroll for inventory-only changes).",
    },
    null,
    2,
  ),
);

process.exit(ok ? 0 : 1);
