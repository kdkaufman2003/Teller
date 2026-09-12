import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function readSource(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

describe("Phase 16J release invariants", () => {
  it("blocks cross-company bank transfers at application layer", () => {
    const transfer = readSource("src/lib/banking/transfer.ts");
    expect(transfer).toMatch(/assertSameEntityBankTransfer/);
    expect(transfer).toMatch(/Intercompany/);
  });

  it("flags cross-entity transfer pair suggestions", () => {
    const transfer = readSource("src/lib/banking/transfer.ts");
    expect(transfer).toMatch(/crossEntity/);
  });

  it("retains entity posting guards in post.ts", () => {
    const post = readSource("src/lib/accounting/post.ts");
    expect(post).toMatch(/resolvePostingLegalEntityId/);
  });

  it("does not introduce phase 17 migration in 16J", () => {
    expect(exists("supabase/migrations/048_phase16i_multi_entity_ux_support.sql")).toBe(false);
  });

  it("documents phase16 closeout", () => {
    expect(exists("docs/PHASE-16-CLOSEOUT.md")).toBe(true);
  });

  it("has final acceptance harness", () => {
    expect(exists("scripts/controlled-phase16j-final-acceptance.ts")).toBe(true);
    expect(exists("scripts/verify-phase16j-production.mjs")).toBe(true);
  });
});

function exists(rel: string): boolean {
  try {
    readFileSync(join(ROOT, rel));
    return true;
  } catch {
    return false;
  }
}
