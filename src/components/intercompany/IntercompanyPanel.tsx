"use client";

import { useState } from "react";
import { money } from "@/lib/format";

type EntityOption = { id: string; name: string; entityCode: string };
type AccountOption = { id: string; code: string; name: string };

type TransactionRow = {
  id: string;
  transaction_type: string;
  transaction_date: string;
  description: string;
  amount: number;
  status: string;
  source_legal_entity_id: string;
  counterparty_legal_entity_id: string;
  source_journal_id: string | null;
  counterparty_journal_id: string | null;
};

const TYPE_LABELS: Record<string, string> = {
  expense_on_behalf: "Paid expense for another company",
  cash_received_on_behalf: "Received money for another company",
  fund_transfer: "Transfer between companies",
  manual: "Manual intercompany entry",
};

export function IntercompanyPanel({
  entities,
  accountsByEntity,
  initialTransactions,
  canWrite,
}: {
  entities: EntityOption[];
  accountsByEntity: Record<string, AccountOption[]>;
  initialTransactions: TransactionRow[];
  canWrite: boolean;
}) {
  const [transactions, setTransactions] = useState(initialTransactions);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [transactionType, setTransactionType] = useState("fund_transfer");
  const [sourceEntityId, setSourceEntityId] = useState(entities[0]?.id ?? "");
  const [counterpartyEntityId, setCounterpartyEntityId] = useState(entities[1]?.id ?? "");
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [sourceCashAccountId, setSourceCashAccountId] = useState("");
  const [counterpartyCashAccountId, setCounterpartyCashAccountId] = useState("");
  const [sourcePaymentAccountId, setSourcePaymentAccountId] = useState("");
  const [counterpartyExpenseAccountId, setCounterpartyExpenseAccountId] = useState("");
  const [counterpartyCreditAccountId, setCounterpartyCreditAccountId] = useState("");

  const [reconEntityA, setReconEntityA] = useState(entities[0]?.id ?? "");
  const [reconEntityB, setReconEntityB] = useState(entities[1]?.id ?? "");
  const [recon, setRecon] = useState<{
    aDueFromB: number;
    bDueToA: number;
    receivablePayableDifference: number;
    balanced: boolean;
  } | null>(null);

  const entityName = (id: string) => entities.find((e) => e.id === id)?.name ?? id.slice(0, 8);

  async function refreshList() {
    const res = await fetch("/api/accounting/intercompany");
    const data = await res.json();
    if (res.ok) setTransactions(data.transactions ?? []);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    const payload: Record<string, unknown> = {
      transactionType,
      sourceLegalEntityId: sourceEntityId,
      counterpartyLegalEntityId: counterpartyEntityId,
      entryDate,
      amount: Number(amount),
      description,
    };
    if (transactionType === "fund_transfer") {
      payload.sourceCashAccountId = sourceCashAccountId;
      payload.counterpartyCashAccountId = counterpartyCashAccountId;
    } else if (transactionType === "expense_on_behalf") {
      payload.sourcePaymentAccountId = sourcePaymentAccountId;
      payload.counterpartyExpenseAccountId = counterpartyExpenseAccountId;
    } else if (transactionType === "cash_received_on_behalf") {
      payload.sourceCashAccountId = sourceCashAccountId;
      payload.counterpartyCreditAccountId = counterpartyCreditAccountId;
    }

    const res = await fetch("/api/accounting/intercompany", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.error ?? "Could not post transaction");
      return;
    }
    setMessage(data.duplicate ? "Existing transaction returned (idempotent)" : "Intercompany transaction posted");
    await refreshList();
  }

  async function handleReconcile() {
    setError(null);
    const params = new URLSearchParams({ entityAId: reconEntityA, entityBId: reconEntityB });
    const res = await fetch(`/api/accounting/intercompany/reconciliation?${params}`);
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Could not load reconciliation");
      return;
    }
    setRecon(data);
  }

  async function handleReverse(id: string) {
    if (!confirm("Reverse this intercompany transaction?")) return;
    setLoading(true);
    const res = await fetch(`/api/accounting/intercompany/${id}/reverse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.error ?? "Could not reverse");
      return;
    }
    setMessage("Intercompany transaction reversed");
    await refreshList();
  }

  function accountSelect(
    value: string,
    onChange: (v: string) => void,
    entityId: string,
    filter?: (a: AccountOption) => boolean,
  ) {
    const accounts = (accountsByEntity[entityId] ?? []).filter(filter ?? (() => true));
    return (
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)} required>
        <option value="">Select account</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.code} {a.name}
          </option>
        ))}
      </select>
    );
  }

  if (entities.length < 2) {
    return (
      <div className="card p-6">
        <p className="text-muted">
          Intercompany transactions require at least two companies. Add another company under Settings → Companies.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {canWrite ? (
        <form className="card p-6 space-y-4" onSubmit={handleSubmit}>
          <h2 className="text-lg font-medium">New intercompany transaction</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-sm text-muted">Type</span>
              <select
                className="input w-full"
                value={transactionType}
                onChange={(e) => setTransactionType(e.target.value)}
              >
                {Object.entries(TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-muted">Date</span>
              <input className="input w-full" type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} required />
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-muted">Paying / source company</span>
              <select className="input w-full" value={sourceEntityId} onChange={(e) => setSourceEntityId(e.target.value)} required>
                {entities.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-muted">Other company</span>
              <select className="input w-full" value={counterpartyEntityId} onChange={(e) => setCounterpartyEntityId(e.target.value)} required>
                {entities.filter((e) => e.id !== sourceEntityId).map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-muted">Amount</span>
              <input className="input w-full" type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            </label>
            <label className="block space-y-1 md:col-span-2">
              <span className="text-sm text-muted">Description</span>
              <input className="input w-full" value={description} onChange={(e) => setDescription(e.target.value)} required />
            </label>
          </div>

          {transactionType === "fund_transfer" ? (
            <div className="grid gap-4 md:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-sm text-muted">Source company cash account</span>
                {accountSelect(sourceCashAccountId, setSourceCashAccountId, sourceEntityId)}
              </label>
              <label className="block space-y-1">
                <span className="text-sm text-muted">Other company cash account</span>
                {accountSelect(counterpartyCashAccountId, setCounterpartyCashAccountId, counterpartyEntityId)}
              </label>
            </div>
          ) : null}

          {transactionType === "expense_on_behalf" ? (
            <div className="grid gap-4 md:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-sm text-muted">Source payment account (cash/AP)</span>
                {accountSelect(sourcePaymentAccountId, setSourcePaymentAccountId, sourceEntityId)}
              </label>
              <label className="block space-y-1">
                <span className="text-sm text-muted">Other company expense account</span>
                {accountSelect(counterpartyExpenseAccountId, setCounterpartyExpenseAccountId, counterpartyEntityId)}
              </label>
            </div>
          ) : null}

          {transactionType === "cash_received_on_behalf" ? (
            <div className="grid gap-4 md:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-sm text-muted">Source company cash account</span>
                {accountSelect(sourceCashAccountId, setSourceCashAccountId, sourceEntityId)}
              </label>
              <label className="block space-y-1">
                <span className="text-sm text-muted">Other company revenue/clearing account</span>
                {accountSelect(counterpartyCreditAccountId, setCounterpartyCreditAccountId, counterpartyEntityId)}
              </label>
            </div>
          ) : null}

          <button className="btn btn-primary" type="submit" disabled={loading}>
            {loading ? "Posting…" : "Post transaction"}
          </button>
        </form>
      ) : null}

      <div className="card p-6 space-y-4">
        <h2 className="text-lg font-medium">Due to / Due from reconciliation</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <select className="input" value={reconEntityA} onChange={(e) => setReconEntityA(e.target.value)}>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <select className="input" value={reconEntityB} onChange={(e) => setReconEntityB(e.target.value)}>
            {entities.filter((e) => e.id !== reconEntityA).map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-secondary" onClick={handleReconcile}>
            Check balance
          </button>
        </div>
        {recon ? (
          <div className="text-sm space-y-1">
            <p>
              {entityName(reconEntityA)} Due From {entityName(reconEntityB)}: {money(recon.aDueFromB)}
            </p>
            <p>
              {entityName(reconEntityB)} Due To {entityName(reconEntityA)}: {money(recon.bDueToA)}
            </p>
            <p>Difference: {money(recon.receivablePayableDifference)} · {recon.balanced ? "Balanced" : "Review needed"}</p>
          </div>
        ) : null}
      </div>

      {message ? <p className="text-sm text-green-700">{message}</p> : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>From → To</th>
              <th>Description</th>
              <th className="text-right">Amount</th>
              <th>Status</th>
              {canWrite ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {transactions.map((tx) => (
              <tr key={tx.id}>
                <td>{tx.transaction_date}</td>
                <td>{TYPE_LABELS[tx.transaction_type] ?? tx.transaction_type}</td>
                <td>
                  {entityName(tx.source_legal_entity_id)} → {entityName(tx.counterparty_legal_entity_id)}
                </td>
                <td>{tx.description}</td>
                <td className="text-right font-tabular">{money(tx.amount)}</td>
                <td>{tx.status}</td>
                {canWrite && tx.status === "posted" && !tx.id.startsWith("rev") ? (
                  <td>
                    <button type="button" className="text-sm text-muted underline" onClick={() => handleReverse(tx.id)} disabled={loading}>
                      Reverse
                    </button>
                  </td>
                ) : canWrite ? (
                  <td />
                ) : null}
              </tr>
            ))}
            {!transactions.length ? (
              <tr>
                <td colSpan={canWrite ? 7 : 6} className="text-center text-muted py-6">
                  No intercompany transactions yet
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
