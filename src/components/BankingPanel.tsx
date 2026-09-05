"use client";

import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { useRouter } from "next/navigation";
import { money } from "@/lib/format";

type BankingState = {
  configured: boolean;
  serviceRoleConfigured: boolean;
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
  }>;
  unmatchedCount: number;
};

type BankTransaction = {
  id: string;
  posted_date: string;
  amount: number;
  name: string;
  match_status: string;
  match_confidence: number | null;
  metadata?: {
    suggestion?: {
      kind: "invoice_payment" | "expense" | "journal";
      resourceId: string;
      label: string;
      confidence: number;
      reason: string;
    };
  };
};

export function BankingPanel() {
  const router = useRouter();
  const [state, setState] = useState<BankingState | null>(null);
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    const [statusRes, txnRes] = await Promise.all([
      fetch("/api/banking"),
      fetch("/api/banking/transactions?limit=20"),
    ]);
    const status = (await statusRes.json()) as BankingState & { error?: string };
    const txnPayload = (await txnRes.json()) as { transactions?: BankTransaction[]; error?: string };
    if (!statusRes.ok) throw new Error(status.error || "Could not load banking status");
    setState(status);
    setTransactions(txnPayload.transactions ?? []);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Could not load banking"));
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

  async function confirmMatch(transaction: BankTransaction) {
    const suggestion = transaction.metadata?.suggestion;
    if (!suggestion) return;
    setPending(true);
    try {
      const response = await fetch("/api/banking/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transactionId: transaction.id,
          action: "confirm",
          documentId: suggestion.kind === "journal" ? null : suggestion.resourceId,
          journalEntryId: suggestion.kind === "journal" ? suggestion.resourceId : null,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not confirm match");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not confirm match");
    } finally {
      setPending(false);
    }
  }

  if (!state) {
    return <p className="text-sm text-muted">Loading bank connections…</p>;
  }

  return (
    <section className="card space-y-4">
      <div>
        <h2 className="text-lg font-medium">Bank connections</h2>
        <p className="text-sm text-muted">
          Read-only import from your bank via Plaid. Teller never stores bank login credentials.
        </p>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {!state.configured ? (
        <p className="text-sm text-muted">
          Plaid is not configured on the server. Add <code>PLAID_CLIENT_ID</code> and{" "}
          <code>PLAID_SECRET</code> to enable bank import.
        </p>
      ) : !state.serviceRoleConfigured ? (
        <p className="text-sm text-muted">
          <code>SUPABASE_SERVICE_ROLE_KEY</code> is required to store connection tokens securely.
        </p>
      ) : (
        <button
          type="button"
          className="btn-primary"
          disabled={pending}
          onClick={() => void prepareLink()}
        >
          Connect bank account
        </button>
      )}

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

      {state.accounts.length > 0 ? (
        <div className="text-sm">
          <p className="font-medium">Linked accounts</p>
          <ul className="mt-1 space-y-1 text-muted">
            {state.accounts.map((account) => (
              <li key={account.id}>
                {account.name}
                {account.mask ? ` ·••${account.mask}` : ""}
                {account.current_balance != null ? ` · ${money(account.current_balance)}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {transactions.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            Recent bank activity ({state.unmatchedCount} need attention)
          </p>
          <ul className="divide-y text-sm">
            {transactions.map((txn) => (
              <li key={txn.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <p>{txn.name}</p>
                  <p className="text-muted">
                    {txn.posted_date} · {money(Math.abs(Number(txn.amount)))}{" "}
                    {Number(txn.amount) < 0 ? "in" : "out"} · {txn.match_status}
                  </p>
                  {txn.metadata?.suggestion ? (
                    <p className="text-muted">
                      Suggested: {txn.metadata.suggestion.label} (
                      {Math.round(txn.metadata.suggestion.confidence * 100)}%)
                    </p>
                  ) : null}
                </div>
                {txn.match_status === "suggested" ? (
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={pending}
                    onClick={() => void confirmMatch(txn)}
                  >
                    Confirm match
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
