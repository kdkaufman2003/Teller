#!/usr/bin/env node
/** Compare pre/post Phase 15 deploy snapshots — HFAC + journal invariants. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function diffCounts(before, after, label) {
  const rows = [];
  for (const key of Object.keys(before)) {
    const pre = before[key];
    const post = after[key];
    if (pre !== post) {
      rows.push({ field: `${label}.${key}`, before: pre, after: post });
    }
  }
  return rows;
}

function main() {
  const prePath = process.argv[2];
  const postPath = process.argv[3];
  if (!prePath || !postPath) {
    console.error("Usage: node scripts/compare-phase15-snapshots.mjs <pre.json> <post.json>");
    process.exit(1);
  }

  const pre = load(resolve(prePath));
  const post = load(resolve(postPath));

  const hfacDiffs = diffCounts(pre.hfac ?? {}, post.hfac ?? {}, "hfac");
  const journalPre = pre.journalIntegrity ?? {};
  const journalPost = post.journalIntegrity ?? {};

  const ok =
    hfacDiffs.length === 0 &&
    journalPost.balanced === true &&
    (journalPost.unbalancedCount ?? 0) === 0;

  console.log(
    JSON.stringify(
      {
        PHASE15_SNAPSHOT_COMPARE: ok ? "PASS" : "FAIL",
        hfacDiffs,
        journalBefore: journalPre,
        journalAfter: journalPost,
        globalTaxReferenceBefore: pre.globalTaxReference ?? {},
        globalTaxReferenceAfter: post.globalTaxReference ?? {},
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : 1);
}

main();
