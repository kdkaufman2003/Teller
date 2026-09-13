import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LIFECYCLE_MATRIX_DOC } from "./helpers";

const ROOT = process.cwd();

describe("Phase 17G certification deliverables", () => {
  it("lifecycle matrix document exists", () => {
    expect(existsSync(join(ROOT, LIFECYCLE_MATRIX_DOC))).toBe(true);
  });

  it("controlled certification runner exists", () => {
    expect(existsSync(join(ROOT, "scripts/controlled-phase17g-e2e-certification.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "scripts/run-controlled-phase17g-e2e-certification.mjs"))).toBe(true);
  });

  it("production verifier exists", () => {
    expect(existsSync(join(ROOT, "scripts/verify-phase17g-production.mjs"))).toBe(true);
  });

  it("domain e2e test files exist", () => {
    const files = [
      "src/lib/e2e/phase17g-ar.test.ts",
      "src/lib/e2e/phase17g-ap.test.ts",
      "src/lib/e2e/phase17g-banking.test.ts",
      "src/lib/e2e/phase17g-inventory.test.ts",
      "src/lib/e2e/phase17g-accounting.test.ts",
      "src/lib/e2e/phase17g-multientity.test.ts",
      "src/lib/e2e/phase17g-security.test.ts",
    ];
    for (const f of files) {
      expect(existsSync(join(ROOT, f))).toBe(true);
    }
  });

  it("no premature patch 055 for 17G", () => {
    expect(existsSync(join(ROOT, "supabase/patches/055_phase17g_e2e_hardening.sql"))).toBe(false);
  });
});
