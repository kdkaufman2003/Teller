#!/usr/bin/env node
/**
 * Run Phase 5–10 controlled demos sequentially in one session.
 * Usage: TELLER_CONTROLLED_PROD_TEST=1 npm run demo:phase5-10:sequential
 */
import { spawnSync } from "node:child_process";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const PHASES = [
  { phase: 5, total: 18, script: "demo:phase5:controlled" },
  { phase: 6, total: 32, script: "demo:phase6:controlled" },
  { phase: 7, total: 45, script: "demo:phase7:controlled" },
  { phase: 8, total: 67, script: "demo:phase8:controlled" },
  { phase: 9, total: 102, script: "demo:phase9:controlled" },
  { phase: 10, total: 110, script: "demo:phase10:controlled" },
];

function parsePassCount(output, phase) {
  const total =
    phase === 10 ? 110 : phase === 9 ? 102 : phase === 8 ? 67 : phase === 7 ? 45 : phase === 6 ? 32 : 18;

  const linePatterns = [
    new RegExp(`Phase ${phase} demo: (\\d+)\\/${total} passed`),
    new RegExp(`"pass":\\s*(\\d+)[\\s\\S]*?"total":\\s*${total}`),
  ];
  for (const pattern of linePatterns) {
    const match = output.match(pattern);
    if (match) return Number(match[1]);
  }

  // Phase 5 runner emits JSON summary: { "passed": 18, "failed": 0, ... }
  if (phase === 5) {
    const jsonMatch = output.match(/"passed"\s*:\s*(\d+)[\s\S]*?"failed"\s*:\s*0/);
    if (jsonMatch) return Number(jsonMatch[1]);
  }

  return null;
}

loadControlledProdEnv();

const summary = {};
let failed = false;

for (const { phase, total, script } of PHASES) {
  const result = spawnSync("npm", ["run", script], {
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  process.stdout.write(output);
  const passed = parsePassCount(output, phase);
  summary[`PHASE${phase}_SEQUENTIAL`] = passed === total ? `${total}/${total}` : `${passed ?? "?"}/${total}`;
  if (result.status !== 0 || passed !== total) failed = true;
}

console.log(JSON.stringify({ summary, failed }, null, 2));
process.exit(failed ? 1 : 0);
