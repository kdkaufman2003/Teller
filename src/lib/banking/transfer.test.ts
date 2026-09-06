import { describe, expect, it, vi } from "vitest";
import { detectTransferPairs, createBankTransfer } from "./transfer";

describe("detectTransferPairs", () => {
  it("detects opposite transactions across accounts", () => {
    const pairs = detectTransferPairs([
      {
        id: "txn-out",
        bank_account_id: "checking",
        posted_date: "2026-05-01",
        normalized_amount: -5000,
        description: "Transfer to savings",
      },
      {
        id: "txn-in",
        bank_account_id: "savings",
        posted_date: "2026-05-01",
        normalized_amount: 5000,
        description: "Transfer from checking",
      },
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      sourceTransactionId: "txn-out",
      destinationTransactionId: "txn-in",
      amount: 5000,
    });
  });

  it("ignores same-sign transactions", () => {
    const pairs = detectTransferPairs([
      {
        id: "txn-1",
        bank_account_id: "checking",
        posted_date: "2026-05-01",
        normalized_amount: -100,
      },
      {
        id: "txn-2",
        bank_account_id: "savings",
        posted_date: "2026-05-01",
        normalized_amount: -100,
      },
    ]);
    expect(pairs).toHaveLength(0);
  });

  it("ignores amount mismatches beyond tolerance", () => {
    const pairs = detectTransferPairs([
      {
        id: "txn-1",
        bank_account_id: "checking",
        posted_date: "2026-05-01",
        normalized_amount: -5000,
      },
      {
        id: "txn-2",
        bank_account_id: "savings",
        posted_date: "2026-05-01",
        normalized_amount: 4990,
      },
    ]);
    expect(pairs).toHaveLength(0);
  });
});

describe("createBankTransfer", () => {
  it("calls teller_create_bank_transfer RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { transfer_id: "xfer-1", journal_entry_id: "je-1", duplicate: false },
      error: null,
    });
    const from = vi.fn().mockReturnValue({ insert: vi.fn().mockResolvedValue({ error: null }) });
    const supabase = { rpc, from } as unknown as Parameters<typeof createBankTransfer>[0];

    const result = await createBankTransfer(supabase, {
      organizationId: "org-1",
      sourceBankTransactionId: "txn-out",
      destinationBankTransactionId: "txn-in",
      amount: 5000,
      transferDate: "2026-05-01",
      actorId: "user-1",
    });

    expect(rpc).toHaveBeenCalledWith(
      "teller_create_bank_transfer",
      expect.objectContaining({
        p_source_bank_transaction_id: "txn-out",
        p_destination_bank_transaction_id: "txn-in",
        p_amount: 5000,
      }),
    );
    expect(result.transferId).toBe("xfer-1");
  });
});
