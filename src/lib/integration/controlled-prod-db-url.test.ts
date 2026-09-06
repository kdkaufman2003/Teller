import { describe, expect, it } from "vitest";
import {
  assertProductionDbUrl,
  parseSupabaseDbProjectRef,
  PRODUCTION_REF,
} from "../../../scripts/controlled-prod-db-url.mjs";

describe("controlled production database URL guards", () => {
  it("parses direct Supabase database host refs", () => {
    expect(
      parseSupabaseDbProjectRef(
        "postgresql://postgres:secret@db.ypixbxicdecwfafculha.supabase.co:5432/postgres",
      ),
    ).toBe(PRODUCTION_REF);
  });

  it("parses pooler connection strings with postgres.[ref] user", () => {
    expect(
      parseSupabaseDbProjectRef(
        "postgresql://postgres.ypixbxicdecwfafculha:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
      ),
    ).toBe(PRODUCTION_REF);
  });

  it("rejects unrecognized database hosts", () => {
    expect(parseSupabaseDbProjectRef("postgresql://postgres:secret@localhost:5432/postgres")).toBe(
      null,
    );
  });

  it("assertProductionDbUrl accepts production ref", () => {
    expect(
      assertProductionDbUrl(
        "postgresql://postgres:secret@db.ypixbxicdecwfafculha.supabase.co:5432/postgres",
      ),
    ).toBe(PRODUCTION_REF);
  });

  it("assertProductionDbUrl rejects missing URL", () => {
    expect(() => assertProductionDbUrl("")).toThrow(/Missing SUPABASE_DB_URL/i);
  });

  it("assertProductionDbUrl rejects non-production ref", () => {
    expect(() =>
      assertProductionDbUrl(
        "postgresql://postgres:secret@db.pyqmzcainjezpkkeklhv.supabase.co:5432/postgres",
      ),
    ).toThrow(/must target production ref/i);
  });
});
