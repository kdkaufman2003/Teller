"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { money } from "@/lib/format";
import { accountingAdjustmentPath, routes } from "@/lib/routes";

type AccountOption = { id: string; code: string; name: string };

type LineDraft = {
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
};

const emptyLine = (accountId = ""): LineDraft => ({
  accountId,
  debit: "",
  credit: "",
  memo: "",
});

export default function NewAdjustmentPage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState("");
  const [reference, setReference] = useState("");
  const [adjustmentType, setAdjustmentType] = useState("general");
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(), emptyLine()]);
  const [postOnSave, setPostOnSave] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/accounts")
      .then((response) => response.json())
      .then((data: { accounts?: AccountOption[] }) => {
        const list = data.accounts ?? [];
        setAccounts(list);
        setLines((current) =>
          current.map((line, index) => ({
            ...line,
            accountId: line.accountId || list[index]?.id || list[0]?.id || "",
          })),
        );
      });
  }, []);

  const totalDebit = lines.reduce((sum, line) => sum + (Number(line.debit) || 0), 0);
  const totalCredit = lines.reduce((sum, line) => sum + (Number(line.credit) || 0), 0);
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01 && totalDebit > 0;

  function updateLine(index: number, patch: Partial<LineDraft>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  function addLine() {
    setLines((current) => [...current, emptyLine(accounts[0]?.id ?? "")]);
  }

  function removeLine(index: number) {
    setLines((current) => (current.length <= 2 ? current : current.filter((_, i) => i !== index)));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!balanced) {
      setError("Debits and credits must balance.");
      return;
    }

    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/accounting/adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entryDate,
          memo,
          reference,
          adjustmentType,
          post: postOnSave,
          lines: lines.map((line) => ({
            accountId: line.accountId,
            debit: Number(line.debit) || 0,
            credit: Number(line.credit) || 0,
            memo: line.memo || undefined,
          })),
        }),
      });
      const payload = (await response.json()) as {
        error?: string;
        adjustment?: { id: string };
      };
      if (!response.ok) throw new Error(payload.error || "Could not create adjustment");

      const id = payload.adjustment?.id;
      router.push(id ? accountingAdjustmentPath(id) : routes.accountingAdjustments);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create adjustment");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <header className="page-header">
        <Link href={routes.accountingAdjustments} className="text-sm text-muted">
          ← Adjustments
        </Link>
        <h1 className="mt-2">New adjusting entry</h1>
      </header>

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          {error}
        </p>
      ) : null}

      <form onSubmit={submit} className="space-y-6">
        <div className="card grid gap-4 p-4 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-muted">Entry date</span>
            <input
              type="date"
              className="input w-full"
              value={entryDate}
              onChange={(event) => setEntryDate(event.target.value)}
              required
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted">Type</span>
            <select
              className="input w-full"
              value={adjustmentType}
              onChange={(event) => setAdjustmentType(event.target.value)}
            >
              <option value="general">General</option>
              <option value="accrual">Accrual</option>
              <option value="deferral">Deferral</option>
              <option value="reclassification">Reclassification</option>
            </select>
          </label>
          <label className="space-y-1 text-sm md:col-span-2">
            <span className="text-muted">Memo</span>
            <input
              className="input w-full"
              value={memo}
              onChange={(event) => setMemo(event.target.value)}
              required
            />
          </label>
          <label className="space-y-1 text-sm md:col-span-2">
            <span className="text-muted">Reference (optional)</span>
            <input
              className="input w-full"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </label>
        </div>

        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <span className="font-medium">Lines</span>
            <button type="button" className="btn text-sm" onClick={addLine}>
              Add line
            </button>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Account</th>
                <th className="text-right">Debit</th>
                <th className="text-right">Credit</th>
                <th>Memo</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={index}>
                  <td>
                    <select
                      className="input w-full min-w-[12rem]"
                      value={line.accountId}
                      onChange={(event) => updateLine(index, { accountId: event.target.value })}
                      required
                    >
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.code} · {account.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="input w-full font-tabular text-right"
                      value={line.debit}
                      onChange={(event) => updateLine(index, { debit: event.target.value, credit: "" })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="input w-full font-tabular text-right"
                      value={line.credit}
                      onChange={(event) => updateLine(index, { credit: event.target.value, debit: "" })}
                    />
                  </td>
                  <td>
                    <input
                      className="input w-full"
                      value={line.memo}
                      onChange={(event) => updateLine(index, { memo: event.target.value })}
                    />
                  </td>
                  <td className="text-right">
                    <button
                      type="button"
                      className="text-sm text-muted hover:text-navy"
                      onClick={() => removeLine(index)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t px-4 py-3 text-sm">
            Debits {money(totalDebit)} · Credits {money(totalCredit)}{" "}
            {balanced ? "✓ balanced" : "— out of balance"}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={postOnSave}
              onChange={(event) => setPostOnSave(event.target.checked)}
            />
            Post immediately
          </label>
          <button type="submit" className="btn btn-primary" disabled={pending || !balanced}>
            {pending ? "Saving…" : postOnSave ? "Save and post" : "Save draft"}
          </button>
        </div>
      </form>
    </div>
  );
}
