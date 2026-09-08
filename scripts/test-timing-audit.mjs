#!/usr/bin/env node
/** Profile major test commands and emit a timing table. */
import { spawnSync } from "node:child_process";

const COMMANDS = [
  { label: "npm test (full unit)", cmd: "npm", args: ["test"] },
  { label: "demo:phase13:controlled", cmd: "npm", args: ["run", "demo:phase13:controlled"] },
  { label: "demo:phase5-10:sequential", cmd: "npm", args: ["run", "demo:phase5-10:sequential"] },
];

function timeCommand({ label, cmd, args }) {
  const started = Date.now();
  const result = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    label,
    ok: result.status === 0,
    ms: Date.now() - started,
  };
}

const rows = [];
for (const command of COMMANDS) {
  console.error(`Timing: ${command.label}...`);
  rows.push(timeCommand(command));
}

console.log(JSON.stringify({ audit: "TEST_PERFORMANCE", rows }, null, 2));
