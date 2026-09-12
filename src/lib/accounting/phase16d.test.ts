/**
 * Phase 16D design tests — intercompany paired journals (no production DB).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { assertBalanced } from "./post";

const M044 = resolve(process.cwd(), "supabase/migrations/044_phase16d_intercompany.sql");

describe("Phase 16D intercompany design", () => {
  it("migration 044 exists with intercompany group + atomic RPC", () => {
    expect(existsSync(M044)).toBe(true);
    const sql = readFileSync(M044, "utf8");
    expect(sql).toMatch(/teller_intercompany_transactions/);
    expect(sql).toMatch(/teller_intercompany_account_pairs/);
    expect(sql).toMatch(/teller_atomic_post_intercompany/);
    expect(sql).toMatch(/teller_atomic_reverse_intercompany/);
    expect(sql).toMatch(/teller_provision_intercompany_accounts/);
    expect(sql).toMatch(/teller_intercompany_pair_balances/);
  });

  it("due-from is asset and due-to is liability", () => {
    const sql = readFileSync(M044, "utf8");
    expect(sql).toMatch(/'asset'[\s\S]*'due_from'/);
    expect(sql).toMatch(/'liability'[\s\S]*'due_to'/);
  });

  it("entity pair integrity enforced", () => {
    const sql = readFileSync(M044, "utf8");
    expect(sql).toMatch(/teller_ic_tx_entities_distinct/);
    expect(sql).toMatch(/Intercompany transaction requires distinct legal entities/);
    expect(sql).toMatch(/teller_assert_entity_belongs_to_org/);
  });

  it("posted intercompany is immutable", () => {
    const sql = readFileSync(M044, "utf8");
    expect(sql).toMatch(/Posted intercompany transaction cannot be modified/);
    expect(sql).toMatch(/Intercompany transactions cannot be deleted/);
  });

  it("idempotency key unique per org", () => {
    const sql = readFileSync(M044, "utf8");
    expect(sql).toMatch(/teller_ic_tx_idempotency_uidx/);
  });

  it("both entity periods must be open", () => {
    const sql = readFileSync(M044, "utf8");
    expect(sql).toMatch(/Source entity accounting period is closed/);
    expect(sql).toMatch(/Counterparty entity accounting period is closed/);
  });

  it("user must access both entities in atomic RPC", () => {
    const sql = readFileSync(M044, "utf8");
    expect(sql).toMatch(/Not authorized for source legal entity/);
    expect(sql).toMatch(/Not authorized for counterparty legal entity/);
  });

  it("uses paired teller_post_journal calls (one journal per entity)", () => {
    const sql = readFileSync(M044, "utf8");
    const postCalls = sql.match(/teller_post_journal\(/g) ?? [];
    expect(postCalls.length).toBeGreaterThanOrEqual(2);
    expect(sql).toMatch(/'intercompany'/);
    expect(sql).not.toMatch(/CROSS_ENTITY_SINGLE_JOURNAL/i);
  });

  it("expense-on-behalf journal pattern balances independently", () => {
    assertBalanced([
      { account_id: "a", debit: 1000 },
      { account_id: "b", credit: 1000 },
    ]);
    assertBalanced([
      { account_id: "c", debit: 1000 },
      { account_id: "d", credit: 1000 },
    ]);
  });

  it("no consolidation tables in 16D migration", () => {
    const sql = readFileSync(M044, "utf8");
    expect(sql).not.toMatch(/create table public\.teller_.*consolidat/i);
    expect(sql).not.toMatch(/create table public\.teller_.*elimination/i);
  });

  it("application posting module exists", () => {
    expect(existsSync(resolve(process.cwd(), "src/lib/accounting/intercompany/posting.ts"))).toBe(true);
    expect(existsSync(resolve(process.cwd(), "src/lib/accounting/intercompany/reversal.ts"))).toBe(true);
    expect(existsSync(resolve(process.cwd(), "src/lib/accounting/intercompany/reconciliation.ts"))).toBe(true);
  });

  it("HFAC must not be modified for intercompany", () => {
    const hfacPath = resolve(process.cwd(), "src/lib/integrations/hfac-org.ts");
    if (existsSync(hfacPath)) {
      const hfac = readFileSync(hfacPath, "utf8");
      expect(hfac).not.toMatch(/intercompany/i);
    }
  });
});
