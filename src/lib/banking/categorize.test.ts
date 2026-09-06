import { describe, expect, it, vi } from "vitest";
import {
  categorizeBankTransaction,
  confirmBankMatch,
  excludeBankTransaction,
  normalizeBankingEventId,
  splitCategorizeBankTransaction,
} from "./categorize";

describe("normalizeBankingEventId", () => {
  it("generates UUID when omitted", () => {
    expect(normalizeBankingEventId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("rejects invalid UUIDs", () => {
    expect(() => normalizeBankingEventId("not-a-uuid")).toThrow(/valid UUID/);
  });
});

function mockSupabase(rpcResult: Record<string, unknown>) {
  const rpc = vi.fn().mockResolvedValue({ data: rpcResult, error: null });
  const from = vi.fn().mockReturnValue({ insert: vi.fn().mockResolvedValue({ error: null }) });
  return { rpc, from } as unknown as Parameters<typeof confirmBankMatch>[0];
}

describe("confirmBankMatch", () => {
  it("calls teller_confirm_bank_match RPC", async () => {
    const supabase = mockSupabase({ match_id: "match-1", duplicate: false });
    const result = await confirmBankMatch(supabase, {
      organizationId: "org-1",
      bankTransactionId: "txn-1",
      matchedResourceType: "customer_payment",
      matchedResourceId: "pay-1",
      matchedAmount: 100,
      actorId: "user-1",
    });

    expect(supabase.rpc).toHaveBeenCalledWith(
      "teller_confirm_bank_match",
      expect.objectContaining({
        p_organization_id: "org-1",
        p_bank_transaction_id: "txn-1",
        p_matched_resource_type: "customer_payment",
        p_matched_resource_id: "pay-1",
        p_matched_amount: 100,
      }),
    );
    expect(result.matchId).toBe("match-1");
  });
});

describe("excludeBankTransaction", () => {
  it("calls teller_exclude_bank_transaction RPC", async () => {
    const supabase = mockSupabase({ duplicate: false });
    await excludeBankTransaction(supabase, {
      organizationId: "org-1",
      bankTransactionId: "txn-1",
      actorId: "user-1",
    });

    expect(supabase.rpc).toHaveBeenCalledWith(
      "teller_exclude_bank_transaction",
      expect.objectContaining({
        p_bank_transaction_id: "txn-1",
      }),
    );
  });
});

describe("categorizeBankTransaction", () => {
  it("calls teller_categorize_bank_transaction RPC", async () => {
    const supabase = mockSupabase({ journal_entry_id: "je-1", duplicate: false });
    const result = await categorizeBankTransaction(supabase, {
      organizationId: "org-1",
      bankTransactionId: "txn-1",
      categoryKind: "expense",
      accountId: "acct-expense",
      memo: "Home Depot",
      actorId: "user-1",
    });

    expect(supabase.rpc).toHaveBeenCalledWith(
      "teller_categorize_bank_transaction",
      expect.objectContaining({
        p_category_kind: "expense",
        p_account_id: "acct-expense",
      }),
    );
    expect(result.journalEntryId).toBe("je-1");
  });
});

describe("splitCategorizeBankTransaction", () => {
  it("calls teller_split_categorize_bank_transaction RPC with split payload", async () => {
    const supabase = mockSupabase({ journal_entry_id: "je-2", duplicate: false });
    await splitCategorizeBankTransaction(supabase, {
      organizationId: "org-1",
      bankTransactionId: "txn-1",
      splits: [
        { accountId: "acct-1", amount: 700, memo: "Materials" },
        { accountId: "acct-2", amount: 300, memo: "Tools" },
      ],
      actorId: "user-1",
    });

    expect(supabase.rpc).toHaveBeenCalledWith(
      "teller_split_categorize_bank_transaction",
      expect.objectContaining({
        p_splits: [
          expect.objectContaining({ account_id: "acct-1", amount: 700 }),
          expect.objectContaining({ account_id: "acct-2", amount: 300 }),
        ],
      }),
    );
  });
});
