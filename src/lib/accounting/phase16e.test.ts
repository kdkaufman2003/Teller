/**
 * Phase 16E design tests — intercompany settlement + reconciliation (no production DB).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertAllocationSumMatchesAmount,
  autoApplySettlementAllocations,
} from "./intercompany/settlement/allocation";
import { assertBalanced } from "./post";

const M045 = resolve(process.cwd(), "supabase/migrations/045_phase16e_intercompany_settlement.sql");

describe("Phase 16E intercompany settlement design", () => {
  it("migration 045 exists with settlement tables + atomic RPCs", () => {
    expect(existsSync(M045)).toBe(true);
    const sql = readFileSync(M045, "utf8");
    expect(sql).toMatch(/teller_intercompany_settlements/);
    expect(sql).toMatch(/teller_intercompany_settlement_allocations/);
    expect(sql).toMatch(/teller_atomic_post_intercompany_settlement/);
    expect(sql).toMatch(/teller_atomic_reverse_intercompany_settlement/);
    expect(sql).toMatch(/teller_intercompany_tx_open_balance/);
    expect(sql).toMatch(/teller_intercompany_pair_reconciliation/);
    expect(sql).toMatch(/teller_resolve_entity_cash_account/);
  });

  it("settlement journals clear due-to/due-from without revenue or expense", () => {
    const sql = readFileSync(M045, "utf8");
    expect(sql).toMatch(/'intercompany-settlement'/);
    expect(sql).not.toMatch(/'revenue'/i);
    expect(sql).not.toMatch(/'expense'/i);
    expect(sql).not.toMatch(/teller_tax/);
  });

  it("posted settlement is immutable and hard delete forbidden", () => {
    const sql = readFileSync(M045, "utf8");
    expect(sql).toMatch(/Posted intercompany settlement cannot be modified/);
    expect(sql).toMatch(/Intercompany settlements cannot be deleted/);
  });

  it("settlement idempotency unique per org", () => {
    const sql = readFileSync(M045, "utf8");
    expect(sql).toMatch(/teller_ic_settlement_idempotency_uidx/);
  });

  it("both entity periods must be open for settlement", () => {
    const sql = readFileSync(M045, "utf8");
    expect(sql).toMatch(/Payer entity accounting period is closed/);
    expect(sql).toMatch(/Payee entity accounting period is closed/);
  });

  it("bank account ownership enforced server-side", () => {
    const sql = readFileSync(M045, "utf8");
    expect(sql).toMatch(/Payer bank account belongs to wrong legal entity/);
    expect(sql).toMatch(/Payee bank account belongs to wrong legal entity/);
    expect(sql).toMatch(/teller_resolve_entity_cash_account/);
  });

  it("over-allocation rejected", () => {
    const sql = readFileSync(M045, "utf8");
    expect(sql).toMatch(/Allocation over-applies intercompany transaction/);
  });

  it("bank match foundation includes intercompany_settlement resource type", () => {
    const sql = readFileSync(M045, "utf8");
    expect(sql).toMatch(/intercompany_settlement/);
  });

  it("settlement payer journal pattern balances independently", () => {
    assertBalanced([
      { account_id: "due-to", debit: 4000 },
      { account_id: "cash", credit: 4000 },
    ]);
    assertBalanced([
      { account_id: "cash", debit: 4000 },
      { account_id: "due-from", credit: 4000 },
    ]);
  });

  it("allocation sum validation", () => {
    expect(() =>
      assertAllocationSumMatchesAmount(
        [
          { intercompanyTransactionId: "a", amountApplied: 3000 },
          { intercompanyTransactionId: "b", amountApplied: 3000 },
        ],
        6000,
      ),
    ).not.toThrow();
    expect(() =>
      assertAllocationSumMatchesAmount([{ intercompanyTransactionId: "a", amountApplied: 3000 }], 6000),
    ).toThrow(/sum of allocations/i);
  });

  it("auto-apply is deterministic oldest-first", async () => {
    const supabase = {
      rpc: async () => ({
        data: [
          {
            intercompany_transaction_id: "tx-1",
            transaction_date: "2025-01-01",
            transaction_type: "expense_on_behalf",
            reference: null,
            description: "older",
            original_amount: 3000,
            settled_amount: 0,
            remaining_amount: 3000,
            source_legal_entity_id: "a",
            counterparty_legal_entity_id: "b",
            source_journal_id: null,
            counterparty_journal_id: null,
            status: "open",
          },
          {
            intercompany_transaction_id: "tx-2",
            transaction_date: "2025-02-01",
            transaction_type: "expense_on_behalf",
            reference: null,
            description: "newer",
            original_amount: 4000,
            settled_amount: 0,
            remaining_amount: 4000,
            source_legal_entity_id: "a",
            counterparty_legal_entity_id: "b",
            source_journal_id: null,
            counterparty_journal_id: null,
            status: "open",
          },
        ],
        error: null,
      }),
    } as never;

    const allocations = await autoApplySettlementAllocations(supabase, {
      organizationId: "org",
      payerLegalEntityId: "b",
      payeeLegalEntityId: "a",
      amount: 5000,
    });

    expect(allocations).toEqual([
      { intercompanyTransactionId: "tx-1", amountApplied: 3000 },
      { intercompanyTransactionId: "tx-2", amountApplied: 2000 },
    ]);
  });

  it("no consolidation or elimination in 16E migration", () => {
    const sql = readFileSync(M045, "utf8");
    expect(sql).not.toMatch(/create table public\.teller_.*consolidat/i);
    expect(sql).not.toMatch(/create table public\.teller_.*elimination/i);
  });
});
