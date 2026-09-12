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

type SettlementRow = {
  id: string;
  settlement_date: string;
  amount: number;
  status: string;
  payer_legal_entity_id: string;
  payee_legal_entity_id: string;
  memo: string;
};

type OpenItemRow = {
  intercompanyTransactionId: string;
  transactionDate: string;
  description: string;
  remainingAmount: number;
  originalAmount: number;
};

type ReconReport = {
  aDueFromB: number;
  aDueToB: number;
  bDueFromA: number;
  bDueToA: number;
  receivablePayableDifference: number;
  payableReceivableDifference: number;
  netAOwesB: number;
  netBOwesA: number;
  balanced: boolean;
  openBalance: number;
  openItemsCount: number;
  openItems: OpenItemRow[];
  status: string;
  lastActivity: string | null;
};

const TYPE_LABELS: Record<string, string> = {
  expense_on_behalf: "Paid expense for another company",
  cash_received_on_behalf: "Received money for another company",
  fund_transfer: "Transfer between companies",
  manual: "Manual intercompany entry",
};

const SECTIONS = [
  { id: "transactions", label: "Transactions" },
  { id: "settlements", label: "Settlements" },
  { id: "reconciliation", label: "Reconciliation" },
] as const;

export function IntercompanyPanel({
  entities,
  accountsByEntity,
  initialTransactions,
  initialSettlements = [],
  canWrite,
}: {
  entities: EntityOption[];
  accountsByEntity: Record<string, AccountOption[]>;
  initialTransactions: TransactionRow[];
  initialSettlements?: SettlementRow[];
  canWrite: boolean;
}) {
  const [section, setSection] = useState<(typeof SECTIONS)[number]["id"]>("transactions");
  const [transactions, setTransactions] = useState(initialTransactions);
  const [settlements, setSettlements] = useState(initialSettlements);
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
  const [recon, setRecon] = useState<ReconReport | null>(null);
  const [reconAsOf, setReconAsOf] = useState(new Date().toISOString().slice(0, 10));

  const [settlementPayerId, setSettlementPayerId] = useState(entities[0]?.id ?? "");
  const [settlementPayeeId, setSettlementPayeeId] = useState(entities[1]?.id ?? "");
  const [settlementDate, setSettlementDate] = useState(new Date().toISOString().slice(0, 10));
  const [settlementAmount, setSettlementAmount] = useState("");
  const [settlementMemo, setSettlementMemo] = useState("");
  const [previewAllocations, setPreviewAllocations] = useState<
    Array<{ intercompanyTransactionId: string; amountApplied: number }>
  >([]);

  const entityName = (id: string) => entities.find((e) => e.id === id)?.name ?? id.slice(0, 8);

  async function refreshList() {
    const [txRes, stRes] = await Promise.all([
      fetch("/api/accounting/intercompany"),
      fetch("/api/accounting/intercompany/settlements"),
    ]);
    const txData = await txRes.json();
    const stData = await stRes.json();
    if (txRes.ok) setTransactions(txData.transactions ?? []);
    if (stRes.ok) setSettlements(stData.settlements ?? []);
  }

  async function previewSettlementAllocations() {
    setError(null);
    const amount = Number(settlementAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter a valid settlement amount to preview allocations");
      return;
    }
    const res = await fetch(
      `/api/accounting/intercompany/open-items?entityAId=${settlementPayerId}&entityBId=${settlementPayeeId}&asOf=${settlementDate}`,
    );
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Could not load open items");
      return;
    }
    let remaining = amount;
    const allocations: Array<{ intercompanyTransactionId: string; amountApplied: number }> = [];
    for (const item of (data.openItems ?? []) as OpenItemRow[]) {
      if (remaining <= 0.009) break;
      const apply = Math.min(remaining, item.remainingAmount);
      if (apply <= 0.009) continue;
      allocations.push({
        intercompanyTransactionId: item.intercompanyTransactionId,
        amountApplied: apply,
      });
      remaining -= apply;
    }
    if (remaining > 0.009) {
      setError("Settlement amount exceeds open balance for this company pair");
      setPreviewAllocations([]);
      return;
    }
    setPreviewAllocations(allocations);
    setMessage(`Preview: ${allocations.length} open item(s) will be applied (oldest first)`);
  }

  async function handleSettlementSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    const res = await fetch("/api/accounting/intercompany/settlements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payerLegalEntityId: settlementPayerId,
        payeeLegalEntityId: settlementPayeeId,
        settlementDate,
        amount: Number(settlementAmount),
        memo: settlementMemo || "Intercompany settlement",
        autoApply: previewAllocations.length === 0,
        allocations: previewAllocations.length ? previewAllocations : undefined,
      }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.error ?? "Could not post settlement");
      return;
    }
    setMessage(data.duplicate ? "Existing settlement returned (idempotent)" : "Settlement posted");
    setPreviewAllocations([]);
    await refreshList();
  }

  async function handleSettlementReverse(id: string) {
    if (!confirm("Reverse this settlement? Open balances will be restored.")) return;
    setLoading(true);
    const res = await fetch(`/api/accounting/intercompany/settlements/${id}/reverse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.error ?? "Could not reverse settlement");
      return;
    }
    setMessage("Settlement reversed");
    await refreshList();
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
    const params = new URLSearchParams({
      entityAId: reconEntityA,
      entityBId: reconEntityB,
      detailed: "1",
      asOf: reconAsOf,
    });
    const res = await fetch(`/api/accounting/intercompany/reconciliation?${params}`);
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Could not load reconciliation");
      return;
    }
    setRecon(data);
  }

  function ownerSummary(report: ReconReport) {
    const aName = entityName(reconEntityA);
    const bName = entityName(reconEntityB);
    if (report.netAOwesB > 0.009) {
      return `${aName} owes ${bName} ${money(report.netAOwesB)}`;
    }
    if (report.netBOwesA > 0.009) {
      return `${bName} owes ${aName} ${money(report.netBOwesA)}`;
    }
    return "No net balance between these companies";
  }

  function statusLabel(status: string) {
    if (status === "RECONCILED") return "Reconciled";
    if (status === "OUT_OF_BALANCE") return "Needs review";
    if (status === "OPEN_BALANCE") return "Open balance";
    return "Pending review";
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
      <div className="flex flex-wrap gap-2">
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={section === item.id ? "btn btn-primary" : "btn btn-secondary"}
            onClick={() => setSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {section === "transactions" && canWrite ? (
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

      {section === "settlements" && canWrite ? (
        <form className="card p-6 space-y-4" onSubmit={handleSettlementSubmit}>
          <h2 className="text-lg font-medium">Record payment between companies</h2>
          <p className="text-sm text-muted">
            Clears existing due-to / due-from balances. No revenue or expense is created.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-sm text-muted">Paying company</span>
              <select className="input w-full" value={settlementPayerId} onChange={(e) => setSettlementPayerId(e.target.value)} required>
                {entities.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-muted">Receiving company</span>
              <select className="input w-full" value={settlementPayeeId} onChange={(e) => setSettlementPayeeId(e.target.value)} required>
                {entities.filter((e) => e.id !== settlementPayerId).map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-muted">Payment date</span>
              <input className="input w-full" type="date" value={settlementDate} onChange={(e) => setSettlementDate(e.target.value)} required />
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-muted">Amount</span>
              <input className="input w-full" type="number" min="0.01" step="0.01" value={settlementAmount} onChange={(e) => setSettlementAmount(e.target.value)} required />
            </label>
            <label className="block space-y-1 md:col-span-2">
              <span className="text-sm text-muted">Memo</span>
              <input className="input w-full" value={settlementMemo} onChange={(e) => setSettlementMemo(e.target.value)} />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary" onClick={previewSettlementAllocations} disabled={loading}>
              Preview open-item allocation
            </button>
            <button className="btn btn-primary" type="submit" disabled={loading}>
              {loading ? "Posting…" : "Post settlement"}
            </button>
          </div>
          {previewAllocations.length ? (
            <ul className="text-sm text-muted space-y-1">
              {previewAllocations.map((row) => (
                <li key={row.intercompanyTransactionId}>
                  Apply {money(row.amountApplied)} to item {row.intercompanyTransactionId.slice(0, 8)}…
                </li>
              ))}
            </ul>
          ) : null}
        </form>
      ) : null}

      {section === "reconciliation" ? (
        <div className="card p-6 space-y-4">
          <h2 className="text-lg font-medium">Reconciliation</h2>
          <div className="grid gap-4 md:grid-cols-4">
            <select className="input" value={reconEntityA} onChange={(e) => setReconEntityA(e.target.value)}>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
            <select className="input" value={reconEntityB} onChange={(e) => setReconEntityB(e.target.value)}>
              {entities.filter((e) => e.id !== reconEntityA).map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
            <input className="input" type="date" value={reconAsOf} onChange={(e) => setReconAsOf(e.target.value)} />
            <button type="button" className="btn btn-secondary" onClick={handleReconcile}>
              Run report
            </button>
          </div>
          {recon ? (
            <div className="space-y-4 text-sm">
              <p className="text-base font-medium">{ownerSummary(recon)}</p>
              <p className="text-muted">Status: {statusLabel(recon.status)} · Open items: {recon.openItemsCount}</p>
              <div className="grid gap-2 md:grid-cols-2">
                <p>{entityName(reconEntityA)} Due From {entityName(reconEntityB)}: {money(recon.aDueFromB)}</p>
                <p>{entityName(reconEntityB)} Due To {entityName(reconEntityA)}: {money(recon.bDueToA)}</p>
                <p>{entityName(reconEntityA)} Due To {entityName(reconEntityB)}: {money(recon.aDueToB)}</p>
                <p>{entityName(reconEntityB)} Due From {entityName(reconEntityA)}: {money(recon.bDueFromA)}</p>
              </div>
              <p>
                Reciprocal differences: receivable {money(recon.receivablePayableDifference)} · payable{" "}
                {money(recon.payableReceivableDifference)}
              </p>
              {recon.openItems.length ? (
                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Description</th>
                        <th className="text-right">Original</th>
                        <th className="text-right">Remaining</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recon.openItems.map((item) => (
                        <tr key={item.intercompanyTransactionId}>
                          <td>{item.transactionDate}</td>
                          <td>{item.description}</td>
                          <td className="text-right font-tabular">{money(item.originalAmount)}</td>
                          <td className="text-right font-tabular">{money(item.remainingAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {message ? <p className="text-sm text-green-700">{message}</p> : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {section === "transactions" ? (
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
                  {canWrite && tx.status === "posted" ? (
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
      ) : null}

      {section === "settlements" ? (
        <div className="card overflow-hidden">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Payer → Payee</th>
                <th>Memo</th>
                <th className="text-right">Amount</th>
                <th>Status</th>
                {canWrite ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {settlements.map((row) => (
                <tr key={row.id}>
                  <td>{row.settlement_date}</td>
                  <td>
                    {entityName(row.payer_legal_entity_id)} → {entityName(row.payee_legal_entity_id)}
                  </td>
                  <td>{row.memo}</td>
                  <td className="text-right font-tabular">{money(row.amount)}</td>
                  <td>{row.status === "posted" ? "Paid" : row.status}</td>
                  {canWrite && row.status === "posted" ? (
                    <td>
                      <button type="button" className="text-sm text-muted underline" onClick={() => handleSettlementReverse(row.id)} disabled={loading}>
                        Reverse
                      </button>
                    </td>
                  ) : canWrite ? (
                    <td />
                  ) : null}
                </tr>
              ))}
              {!settlements.length ? (
                <tr>
                  <td colSpan={canWrite ? 6 : 5} className="text-center text-muted py-6">
                    No settlements yet
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
