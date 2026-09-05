"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Car, PenLine } from "lucide-react";
import { DEFAULT_MILEAGE_RATE, mileageAmount } from "@/lib/expenses/classify";
import { todayISO } from "@/lib/format";

type Account = { id: string; code: string; name: string };

type Classification = {
  vendorName: string;
  amount: number | null;
  issueDate: string | null;
  memo: string;
  accountId: string | null;
  accountCode: string | null;
  confidence: "high" | "medium" | "low";
  reason: string;
  source: "ai" | "rules";
};

type ReadMethod = "vision" | "pdf-text" | "rules";

type ExpenseMode = "receipt" | "mileage" | "manual";

export function ExpensePanel({ accounts }: { accounts: Account[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<ExpenseMode>("receipt");
  const [vendorName, setVendorName] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id || "");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [issueDate, setIssueDate] = useState(todayISO());
  const [miles, setMiles] = useState("");
  const [ratePerMile, setRatePerMile] = useState(String(DEFAULT_MILEAGE_RATE));
  const [attachmentPath, setAttachmentPath] = useState<string | null>(null);
  const [classification, setClassification] = useState<Classification | null>(null);
  const [readMethod, setReadMethod] = useState<ReadMethod | null>(null);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const mileageAccount = useMemo(
    () =>
      accounts.find((row) => row.code === "6100") ??
      accounts.find((row) => /vehicle|fuel|mileage/i.test(row.name)) ??
      accounts[0],
    [accounts],
  );

  const computedMileage = useMemo(() => {
    const m = Number(miles);
    const r = Number(ratePerMile);
    if (!Number.isFinite(m) || !Number.isFinite(r) || m <= 0) return null;
    return mileageAmount(m, r);
  }, [miles, ratePerMile]);

  async function onReceiptSelected(file: File | null) {
    if (!file) return;
    setAnalyzing(true);
    setError("");
    setClassification(null);
    setReadMethod(null);
    setAttachmentPath(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/expenses/analyze-receipt", {
        method: "POST",
        body: form,
      });
      const payload = (await response.json()) as {
        error?: string;
        attachmentPath?: string;
        classification?: Classification;
        readMethod?: ReadMethod;
        aiEnabled?: boolean;
      };
      if (!response.ok) throw new Error(payload.error || "Could not analyze receipt");

      const result = payload.classification;
      if (!result) throw new Error("No classification returned");

      setAttachmentPath(payload.attachmentPath ?? null);
      setClassification(result);
      setReadMethod(payload.readMethod ?? null);
      setAiEnabled(Boolean(payload.aiEnabled));
      setVendorName(result.vendorName);
      setMemo(result.memo);
      if (result.amount != null && Number.isFinite(result.amount)) {
        setAmount(String(result.amount));
      }
      if (result.issueDate) setIssueDate(result.issueDate);
      if (result.accountId) setAccountId(result.accountId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not analyze receipt");
    } finally {
      setAnalyzing(false);
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");

    const body: Record<string, unknown> = {
      issueDate,
      paid: true,
      expenseType: mode,
      attachmentPath,
    };

    if (mode === "mileage") {
      const m = Number(miles);
      const r = Number(ratePerMile);
      if (!Number.isFinite(m) || m <= 0) {
        setError("Enter miles driven");
        setPending(false);
        return;
      }
      body.miles = m;
      body.ratePerMile = r;
      body.accountId = mileageAccount?.id;
      body.memo = memo || `Mileage: ${m} mi @ $${r.toFixed(2)}/mi`;
    } else {
      body.vendorName = vendorName;
      body.accountId = accountId;
      body.amount = Number(amount);
      body.memo = memo;
      if (classification) {
        body.classification = {
          confidence: classification.confidence,
          reason: classification.reason,
          source: classification.source,
          accountCode: classification.accountCode,
        };
      }
    }

    try {
      const response = await fetch("/api/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not save");

      setVendorName("");
      setAmount("");
      setMemo("");
      setMiles("");
      setAttachmentPath(null);
      setClassification(null);
      setReadMethod(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap gap-1 border-b border-rule bg-paper p-2">
        <ModeButton
          active={mode === "receipt"}
          onClick={() => setMode("receipt")}
          icon={<Camera className="h-4 w-4" aria-hidden />}
          label="Receipt"
        />
        <ModeButton
          active={mode === "mileage"}
          onClick={() => setMode("mileage")}
          icon={<Car className="h-4 w-4" aria-hidden />}
          label="Mileage"
        />
        <ModeButton
          active={mode === "manual"}
          onClick={() => setMode("manual")}
          icon={<PenLine className="h-4 w-4" aria-hidden />}
          label="Manual"
        />
      </div>

      <form onSubmit={onSubmit} className="space-y-3 p-4">
        {mode === "receipt" ? (
          <>
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Upload receipt</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
                disabled={analyzing}
                onChange={(event) => void onReceiptSelected(event.target.files?.[0] ?? null)}
              />
            </label>
            {analyzing ? (
              <p className="text-sm text-muted">Reading vendor, amount, and description…</p>
            ) : null}
            {classification ? (
              <div className="rounded-lg bg-paper px-3 py-2 text-sm text-muted space-y-1">
                <p>
                  <strong className="text-ink">Vendor:</strong>{" "}
                  {classification.vendorName || "—"}
                  {classification.amount != null ? (
                    <>
                      {" "}
                      · <strong className="text-ink">Amount:</strong> $
                      {classification.amount.toFixed(2)}
                    </>
                  ) : null}
                </p>
                {classification.memo ? (
                  <p>
                    <strong className="text-ink">Description:</strong> {classification.memo}
                  </p>
                ) : null}
                <p>
                  <strong className="text-ink">Category:</strong> {classification.accountCode} —{" "}
                  {classification.reason}
                  {classification.confidence !== "high" ? " (please confirm)" : ""}
                </p>
                <p className="text-xs">
                  {readMethod === "vision"
                    ? "Read from photo"
                    : readMethod === "pdf-text"
                      ? "Read from PDF"
                      : aiEnabled
                        ? "Could not auto-read — review fields"
                        : "Add OPENAI_API_KEY on Vercel to auto-read receipts"}
                </p>
              </div>
            ) : null}
          </>
        ) : null}

        {mode === "mileage" ? (
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-sm">
              <span className="mb-1 block text-muted">Miles driven</span>
              <input
                type="number"
                min="0"
                step="0.1"
                value={miles}
                onChange={(event) => setMiles(event.target.value)}
                required
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted">Rate per mile ($)</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={ratePerMile}
                onChange={(event) => setRatePerMile(event.target.value)}
                required
              />
            </label>
            <div className="text-sm">
              <span className="mb-1 block text-muted">Amount</span>
              <p className="rounded-lg border border-rule bg-paper-strong px-3 py-2 font-tabular">
                {computedMileage != null ? `$${computedMileage.toFixed(2)}` : "—"}
              </p>
              <p className="mt-1 text-xs text-muted">
                Posts to {mileageAccount?.code} {mileageAccount?.name}
              </p>
            </div>
          </div>
        ) : null}

        {mode !== "mileage" ? (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <input
              placeholder="Vendor"
              value={vendorName}
              onChange={(event) => setVendorName(event.target.value)}
            />
            <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} {account.name}
                </option>
              ))}
            </select>
            <input
              placeholder="Amount"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
              type="number"
              min="0"
              step="0.01"
            />
            <input
              type="date"
              value={issueDate}
              onChange={(event) => setIssueDate(event.target.value)}
            />
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            <input
              type="date"
              value={issueDate}
              onChange={(event) => setIssueDate(event.target.value)}
            />
            <input
              placeholder="Memo (optional)"
              value={memo}
              onChange={(event) => setMemo(event.target.value)}
            />
          </div>
        )}

        {mode !== "mileage" ? (
            <input
              placeholder="Description / memo"
              value={memo}
              onChange={(event) => setMemo(event.target.value)}
            />
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <button className="btn btn-primary" disabled={pending || analyzing} type="submit">
            {pending ? "Saving…" : "Record expense"}
          </button>
          {attachmentPath ? (
            <span className="text-xs text-muted">Receipt attached</span>
          ) : null}
        </div>

        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </form>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ${
        active ? "bg-navy text-white" : "text-muted hover:bg-paper-strong"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
