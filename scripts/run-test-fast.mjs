#!/usr/bin/env node
/** Level 1 — fast development loop: scoped unit tests, no DB writes. */
import { spawn } from "node:child_process";
import { CURRENT_PHASE, FAST_UNIT_PATTERNS, PHASE_VERIFY } from "./test-tier-config.mjs";

function runAsync(cmd, args) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (c) => {
      output += c;
      process.stdout.write(c);
    });
    child.stderr?.on("data", (c) => {
      output += c;
      process.stderr.write(c);
    });
    child.on("close", (code) => resolve({ ok: code === 0, ms: Date.now() - started, output }));
  });
}

const started = Date.now();
const tasks = [
  runAsync("npx", ["vitest", "run", ...FAST_UNIT_PATTERNS]).then((r) => ({ label: "vitest", ...r })),
];

const verify = PHASE_VERIFY[String(CURRENT_PHASE)];
if (verify) {
  tasks.push(runAsync("npm", ["run", verify]).then((r) => ({ label: "static_verify", ...r })));
}

if (process.env.TELLER_FAST_TYPECHECK === "1") {
  tasks.push(
    runAsync("npx", ["tsc", "--noEmit", "--pretty", "false", "-p", "tsconfig.check.json"]).then((r) => ({
      label: "typecheck",
      ...r,
    })),
  );
}

const steps = await Promise.all(tasks);
const ok = steps.every((step) => step.ok);

console.log(
  JSON.stringify(
    {
      tier: "fast",
      ok,
      elapsedMs: Date.now() - started,
      steps,
      patterns: FAST_UNIT_PATTERNS.length,
      typecheckEnabled: process.env.TELLER_FAST_TYPECHECK === "1",
      note: "No production DB writes. Full typecheck: TELLER_FAST_TYPECHECK=1 or verify:deploy.",
    },
    null,
    2,
  ),
);

process.exit(ok ? 0 : 1);
