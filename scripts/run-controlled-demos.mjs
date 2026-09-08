#!/usr/bin/env node
/**
 * Run controlled phase demos — sequential (default) or parallel when orgs are isolated.
 * Usage: node scripts/run-controlled-demos.mjs 6 7 13
 *        TELLER_DEMO_PARALLEL=1 node scripts/run-controlled-demos.mjs 6 7 9 10 11.1 13
 */
import { spawn, spawnSync } from "node:child_process";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";
import { PHASE_DEMOS, ALL_DEMO_PHASES } from "./test-tier-config.mjs";

function parsePassCount(output, phase, total) {
  const key = String(phase);
  const linePatterns = [
    new RegExp(`Phase ${key.replace(".", "\\.")} demo: (\\d+)\\/${total} passed`),
    new RegExp(`"pass"\\s*:\\s*(\\d+)[\\s\\S]*?"total"\\s*:\\s*${total}`),
    new RegExp(`"passed"\\s*:\\s*(\\d+)[\\s\\S]*?"failed"\\s*:\\s*0`),
  ];
  for (const pattern of linePatterns) {
    const match = output.match(pattern);
    if (match) return Number(match[1]);
  }
  if (phase === 5) {
    const jsonMatch = output.match(/"passed"\s*:\s*(\d+)[\s\S]*?"failed"\s*:\s*0/);
    if (jsonMatch) return Number(jsonMatch[1]);
  }
  const passTrue = (output.match(/"pass"\s*:\s*true/g) ?? []).length;
  if (passTrue >= total) return passTrue;
  return null;
}

function runSequential(phases) {
  const summary = {};
  let failed = false;
  for (const phase of phases) {
    const cfg = PHASE_DEMOS[String(phase)];
    if (!cfg) {
      console.error(`Unknown phase demo: ${phase}`);
      failed = true;
      continue;
    }
    const result = spawnSync("npm", ["run", cfg.script], {
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    process.stdout.write(output);
    const passed = parsePassCount(output, phase, cfg.total) ?? (result.status === 0 ? cfg.total : null);
    summary[`PHASE${phase}`] = passed === cfg.total ? `${cfg.total}/${cfg.total}` : `${passed ?? "?"}/${cfg.total}`;
    if (result.status !== 0 || passed !== cfg.total) failed = true;
  }
  return { summary, failed };
}

function runParallel(phases) {
  return new Promise((resolve) => {
    const summary = {};
    let failed = false;
    let pending = phases.length;
    if (!pending) return resolve({ summary, failed });

    for (const phase of phases) {
      const cfg = PHASE_DEMOS[String(phase)];
      if (!cfg) {
        console.error(`Unknown phase demo: ${phase}`);
        failed = true;
        pending -= 1;
        if (pending === 0) resolve({ summary, failed });
        continue;
      }
      const child = spawn("npm", ["run", cfg.script], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout?.on("data", (chunk) => {
        output += chunk;
        process.stdout.write(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk;
        process.stderr.write(chunk);
      });
      child.on("close", (code) => {
        const passed = parsePassCount(output, phase, cfg.total) ?? (code === 0 ? cfg.total : null);
        summary[`PHASE${phase}`] = passed === cfg.total ? `${cfg.total}/${cfg.total}` : `${passed ?? "?"}/${cfg.total}`;
        if (code !== 0 || passed !== cfg.total) failed = true;
        pending -= 1;
        if (pending === 0) resolve({ summary, failed });
      });
    }
  });
}

async function main() {
  loadControlledProdEnv();
  const phases = process.argv.slice(2).length ? process.argv.slice(2) : ALL_DEMO_PHASES;
  const parallel = process.env.TELLER_DEMO_PARALLEL === "1";

  console.log(
    JSON.stringify(
      { mode: parallel ? "parallel" : "sequential", phases, note: "Each phase uses its own demo org" },
      null,
      2,
    ),
  );

  const { summary, failed } = parallel ? await runParallel(phases) : runSequential(phases);
  console.log(JSON.stringify({ summary, failed }, null, 2));
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
