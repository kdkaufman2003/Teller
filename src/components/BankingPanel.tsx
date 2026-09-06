"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { useRouter } from "next/navigation";
import { money } from "@/lib/format";
import type { BankTransactionTab, MatchSuggestionV2 } from "@/lib/banking/types";

type BankingState = {
  configured: boolean;
  serviceRoleConfigured: boolean;
  selectedAccountId: string | null;
  connections: Array<{
    id: string;
    institution_name: string;
    status: string;
    last_synced_at: string | null;
    error_message: string | null;
  }>;
  accounts: Array<{
    id: string;
    name: string;
    mask: string | null;
    current_balance: number | null;
    account_type: string | null;
  }>;
  tabCounts: Record<string, number>;
  balances: {
    providerBalance: number | null;
    bookBalance: number;
    clearedBalance: number;
    difference: number;
    lastSyncedAt: string | null;
  } | null;
};

type BankTransaction = {
  id: string;
  bank_account_id: string;
  posted_date: string;
  amount: number;
  normalized_amount: number;
  direction: string | null;
  description: string;
  name: string;
  status: string;
  match_confidence: number | null;
  metadata?: {
    suggestionV2?: MatchSuggestionV2;
  };
};

const TABS: Array<{ id: BankTransactionTab; label: string }> = [
  { id: "for_review", label: "For review" },
  { id: "matched", label: "Matched" },
  { id: "categorized", label: "Categorized" },
  { id: "excluded", label: "Excluded" },
  { id: "reconciled", label: "Reconciled" },
];

export function BankingPanel() {
  const router = useRouter();
  const [state, setState] = useState<BankingState | null>(null);
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [activeTab, setActiveTab] = useState<BankTransactionTab>("for_review");
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [actionTxnId, setActionTxnId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const accountQuery = selectedAccountId ? `?bankAccountId=${selectedAccountId}` : "";
    const [statusRes, txnRes] = await Promise.all([
      fetch(`/api/banking${accountQuery}`),
      fetch(
        `/api/banking/transactions?tab=${activeTab}&limit=50${
          selectedAccountId ? `&bankAccountId=${selectedAccountId}` : ""
        }`,
      ),
    ]);
    const status = (await statusRes.json()) as BankingState & { error?: string };
    const txnPayload = (await txnRes.json()) as { transactions?: BankTransaction[]; error?: string };
    if (!statusRes.ok) throw new Error(status.error || "Could not load banking status");
    setState(status);
    if (!selectedAccountId && status.selectedAccountId) {
      setSelectedAccountId(status.selectedAccountId);
    }
    setTransactions(txnPayload.transactions ?? []);
  }, [activeTab, selectedAccountId]);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        await load();
        if (!cancelled) setError("");
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load banking");
        }
      }
    }
    void refresh();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function prepareLink() {
    setError("");
    setPending(true);
    try {
      const response = await fetch("/api/banking/link-token", { method: "POST" });
      const payload = (await response.json()) as { linkToken?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not start bank connection");
      setLinkToken(payload.linkToken ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start bank connection");
    } finally {
      setPending(false);
    }
  }

  const onSuccess = useCallback(
    async (publicToken: string | null) => {
      if (!publicToken) return;
      setPending(true);
      setError("");
      try {
        const response = await fetch("/api/banking/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ publicToken, sync: true }),
        });
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(payload.error || "Could not connect bank");
        setLinkToken(null);
        await load();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not connect bank");
      } finally {
        setPending(false);
      }
    },
    [load, router],
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
  });

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  async function syncConnection(connectionId: string) {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/banking/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId, sync: true }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Sync failed");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setPending(false);
    }
  }

  async function postAction(path: string, body: Record<string, unknown>) {
    setPending(true);
    setError("");
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Action failed");
      setActionTxnId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setPending(false);
    }
  }

  async function confirmMatch(transaction: BankTransaction) {
    const suggestion = transaction.metadata?.suggestionV2;
    if (!suggestion) return;
    await postAction("/api/banking/transactions", {
      transactionId: transaction.id,
      action: "confirm",
      matchedResourceType: suggestion.resourceType,
      matchedResourceId: suggestion.resourceId,
      matchedAmount: suggestion.amount,
    });
  }

  async function excludeTransaction(transactionId: string) {
    await postAction("/api/banking/transactions", {
      transactionId,
      action: "exclude",
    });
  }

  const selectedAccount = useMemo(
    () => state?.accounts.find((account) => account.id === selectedAccountId) ?? null,
    [state?.accounts, selectedAccountId],
  );

  if (!state) {
    return <p className="text-sm text-muted">Loading bank connections…</p>;
  }

  return (
    <section className="card space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">Banking</h2>
          <p className="text-sm text-muted">
            Review imported bank activity, match payments, categorize, and reconcile.
          </p>
        </div>
        {state.configured && state.serviceRoleConfigured ? (
          <button
            type="button"
            className="btn-primary"
            disabled={pending}
            onClick={() => void prepareLink()}
          >
            Connect bank
          </button>
        ) : null}
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {state.accounts.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <label className="text-sm">
            <span className="font-medium">Account</span>
            <select
              className="mt-1 w-full rounded border px-2 py-1"
              value={selectedAccountId}
              onChange={(event) => setSelectedAccountId(event.target.value)}
            >
              {state.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                  {account.mask ? ` ·••${account.mask}` : ""}
                </option>
              ))}
            </select>
          </label>

          {state.balances ? (
            <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <BalanceCard label="Provider balance" value={state.balances.providerBalance} />
              <BalanceCard label="Book balance" value={state.balances.bookBalance} />
              <BalanceCard label="Cleared balance" value={state.balances.clearedBalance} />
              <BalanceCard label="Difference" value={state.balances.difference} emphasize />
            </div>
          ) : null}
        </div>
      ) : null}

      {state.connections.length > 0 ? (
        <ul className="space-y-2 text-sm">
          {state.connections.map((connection) => (
            <li key={connection.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {connection.institution_name} · {connection.status}
                {connection.last_synced_at
                  ? ` · synced ${new Date(connection.last_synced_at).toLocaleString()}`
                  : ""}
              </span>
              <button
                type="button"
                className="btn-secondary"
                disabled={pending}
                onClick={() => void syncConnection(connection.id)}
              >
                Sync now
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap gap-2 border-b pb-2">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`rounded px-3 py-1 text-sm ${
              activeTab === tab.id ? "bg-black text-white" : "bg-muted/20 text-muted"
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label} ({state.tabCounts[tab.id] ?? 0})
          </button>
        ))}
      </div>

      {transactions.length > 0 ? (
        <ul className="divide-y text-sm">
          {transactions.map((txn) => {
            const amount = Number(txn.normalized_amount ?? txn.amount);
            const suggestion = txn.metadata?.suggestionV2;
            const isActionOpen = actionTxnId === txn.id;

            return (
              <li key={txn.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{txn.description || txn.name}</p>
                    <p className="text-muted">
                      {txn.posted_date} · {money(Math.abs(amount))}{" "}
                      {amount >= 0 ? "in" : "out"} · {txn.status}
                    </p>
                    {suggestion ? (
                      <p className="text-muted">
                        Suggested: {suggestion.label} ({suggestion.confidenceTier})
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {activeTab === "for_review" && suggestion ? (
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={pending}
                        onClick={() => void confirmMatch(txn)}
                      >
                        Match
                      </button>
                    ) : null}
                    {activeTab === "for_review" ? (
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={pending}
                        onClick={() => setActionTxnId(isActionOpen ? null : txn.id)}
                      >
                        Actions
                      </button>
                    ) : null}
                  </div>
                </div>

                {isActionOpen ? (
                  <div className="flex flex-wrap gap-2 rounded border p-2">
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={pending}
                      onClick={() =>
                        void postAction("/api/banking/categorize", {
                          transactionId: txn.id,
                          categoryKind: "expense",
                          accountId: prompt("Expense account ID") ?? "",
                          memo: txn.description,
                        })
                      }
                    >
                      Categorize
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={pending}
                      onClick={() => void excludeTransaction(txn.id)}
                    >
                      Exclude
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={pending}
                      onClick={async () => {
                        const response = await fetch(
                          `/api/banking/transfers${
                            selectedAccountId ? `?bankAccountId=${selectedAccountId}` : ""
                          }`,
                        );
                        const payload = (await response.json()) as {
                          pairs?: Array<{
                            sourceTransactionId: string;
                            destinationTransactionId: string;
                            amount: number;
                            transferDate: string;
                          }>;
                        };
                        const pair = payload.pairs?.find(
                          (candidate) =>
                            candidate.sourceTransactionId === txn.id ||
                            candidate.destinationTransactionId === txn.id,
                        );
                        if (!pair) {
                          setError("No transfer pair found for this transaction");
                          return;
                        }
                        await postAction("/api/banking/transfers", {
                          sourceBankTransactionId: pair.sourceTransactionId,
                          destinationBankTransactionId: pair.destinationTransactionId,
                          amount: pair.amount,
                          transferDate: pair.transferDate,
                        });
                      }}
                    >
                      Transfer
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted">
          No transactions in {TABS.find((tab) => tab.id === activeTab)?.label.toLowerCase()}.
          {selectedAccount ? ` (${selectedAccount.name})` : ""}
        </p>
      )}
    </section>
  );
}

function BalanceCard({
  label,
  value,
  emphasize = false,
}: {
  label: string;
  value: number | null;
  emphasize?: boolean;
}) {
  return (
    <div className="rounded border p-2">
      <p className="text-muted">{label}</p>
      <p className={emphasize ? "font-semibold" : ""}>
        {value == null ? "—" : money(value)}
      </p>
    </div>
  );
}
