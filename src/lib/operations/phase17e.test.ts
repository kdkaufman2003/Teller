import { describe, expect, it } from "vitest";
import { evaluateRecoveryIntegrity, sumJournalLines } from "./recovery-integrity";
import { parseListPagination, MAX_LIST_PAGE_SIZE } from "@/lib/performance/pagination";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Phase 17E operations", () => {
  it("recovery integrity passes balanced production-like snapshot", () => {
    const result = evaluateRecoveryIntegrity({
      journalCount: 1664,
      unbalancedJournals: 0,
      documentCount: 1197,
      paymentCount: 126,
      legalEntityCount: 29,
      hfacDocuments: 8,
      hfacJournals: 17,
    });
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("recovery integrity detects unbalanced journals", () => {
    const result = evaluateRecoveryIntegrity({
      journalCount: 10,
      unbalancedJournals: 1,
      documentCount: 5,
      paymentCount: 2,
      legalEntityCount: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "UNBALANCED_JOURNALS")).toBe(true);
  });

  it("sumJournalLines detects imbalance", () => {
    expect(
      sumJournalLines([
        { debit: 100, credit: 0 },
        { debit: 0, credit: 50 },
      ]).balanced,
    ).toBe(false);
    expect(
      sumJournalLines([
        { debit: 100, credit: 0 },
        { debit: 0, credit: 100 },
      ]).balanced,
    ).toBe(true);
  });

  it("audit pagination is bounded", () => {
    const params = parseListPagination(new URLSearchParams("pageSize=99999"));
    expect(params.pageSize).toBe(MAX_LIST_PAGE_SIZE);
  });

  it("patch 054 blocks audit updates and includes probe", () => {
    const sql = readFileSync(
      join(process.cwd(), "supabase/patches/054_phase17e_operational_controls.sql"),
      "utf8",
    );
    expect(sql).toContain("teller_audit_append_only_guard");
    expect(sql).toContain("teller_phase17e_operations_probe");
    expect(sql).not.toMatch(/delete from public.teller_audit_events/i);
    expect(sql).not.toMatch(/disable row level security/i);
  });

  it("ready route does not expose secrets", () => {
    const route = readFileSync(join(process.cwd(), "src/app/api/ready/route.ts"), "utf8");
    expect(route).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(route).toContain("checkDatabaseReadiness");
  });

  it("ops status requires bearer token", () => {
    const route = readFileSync(join(process.cwd(), "src/app/api/ops/status/route.ts"), "utf8");
    expect(route).toContain("TELLER_OPS_STATUS_TOKEN");
    expect(route).not.toMatch(/console\.log.*token/i);
  });

  it("banking match actions use dedicated audit types", () => {
    const bankingAudit = readFileSync(join(process.cwd(), "src/lib/banking/audit.ts"), "utf8");
    expect(bankingAudit).toContain('"banking.match.confirmed": "banking.match.confirmed"');
    expect(bankingAudit).toContain('"banking.match.removed": "banking.match.removed"');
  });
});
