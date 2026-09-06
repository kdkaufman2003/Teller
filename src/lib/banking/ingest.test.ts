import { describe, expect, it, vi } from "vitest";
import { importBankTransactionsBatch, mapTransactionToRpcRow } from "./ingest";
import { toNormalizedBankTransaction } from "./types";

describe("mapTransactionToRpcRow", () => {
  it("maps normalized transaction fields to RPC payload", () => {
    const row = mapTransactionToRpcRow(
      toNormalizedBankTransaction({
        providerTransactionId: "txn-1",
        providerAccountId: "acct-1",
        postedDate: "2026-05-01",
        rawAmount: -100,
        description: "Deposit",
        pending: false,
        importFingerprint: "abc123",
      }),
    );

    expect(row).toMatchObject({
      provider_transaction_id: "txn-1",
      posted_date: "2026-05-01",
      raw_amount: -100,
      description: "Deposit",
      import_fingerprint: "abc123",
    });
  });
});

describe("importBankTransactionsBatch", () => {
  it("calls teller_import_bank_transactions RPC with batch payload", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { imported: 2, updated: 1, superseded: 0, removed: 0, duplicates: 0 },
      error: null,
    });
    const from = vi.fn().mockReturnValue({ insert: vi.fn().mockResolvedValue({ error: null }) });
    const supabase = { rpc, from } as unknown as Parameters<typeof importBankTransactionsBatch>[0];

    const result = await importBankTransactionsBatch(
      supabase,
      {
        organizationId: "org-1",
        bankAccountId: "bank-1",
        provider: "plaid",
        transactions: [
          toNormalizedBankTransaction({
            providerTransactionId: "txn-1",
            providerAccountId: "acct-1",
            postedDate: "2026-05-01",
            rawAmount: -50,
            description: "Inflow",
            pending: false,
          }),
        ],
        removedProviderTransactionIds: ["removed-1"],
      },
      { audit: false },
    );

    expect(rpc).toHaveBeenCalledWith("teller_import_bank_transactions", {
      p_organization_id: "org-1",
      p_bank_account_id: "bank-1",
      p_provider: "plaid",
      p_transactions: expect.any(Array),
      p_removed_provider_ids: ["removed-1"],
      p_import_batch_id: null,
    });
    expect(result.imported).toBe(2);
    expect(result.updated).toBe(1);
  });

  it("throws when RPC returns an error", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "duplicate provider id" } }),
    } as unknown as Parameters<typeof importBankTransactionsBatch>[0];

    await expect(
      importBankTransactionsBatch(
        supabase,
        {
          organizationId: "org-1",
          bankAccountId: "bank-1",
          provider: "plaid",
          transactions: [],
        },
        { audit: false },
      ),
    ).rejects.toThrow("duplicate provider id");
  });
});
