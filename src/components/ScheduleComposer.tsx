"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { money } from "@/lib/format";
import { routes, scheduleDetailPath, scheduleNewPath } from "@/lib/routes";
import type { ScheduleType } from "@/lib/accounting/schedules/types";
import { DEFERRED_REVENUE_V1_NOTE } from "@/lib/accounting/schedules/deferred-revenue";

type AccountOption = { id: string; code: string; name: string };
type JobOption = { id: string; name: string };
type DepositSource = {
  paymentId: string;
  paymentDate: string;
  memo: string;
  originalAmount: number;
  appliedAmount: number;
  availableForSchedule: number;
  fullyApplied: boolean;
};

type PreviewRow = { occurrenceDate: string; amount: number; remainingAfter: number; isFinal: boolean };

const TYPE_LABELS: Record<ScheduleType, string> = {
  prepaid_expense: "Prepaid expense",
  accrued_expense: "Accrued expense",
  deferred_revenue: "Deferred revenue recognition",
};

export function ScheduleComposer({
  initialType,
  editScheduleId,
}: {
  initialType?: ScheduleType;
  editScheduleId?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loadedType, setLoadedType] = useState<ScheduleType | null>(null);
  const scheduleType = (editScheduleId
    ? loadedType
    : (searchParams.get("type") ?? initialType ?? "prepaid_expense")) as ScheduleType;

  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [jobs, setJobs] = useState<JobOption[]>([]);
  const [deposits, setDeposits] = useState<DepositSource[]>([]);
  const [name, setName] = useState("");
  const [reference, setReference] = useState("");
  const [memo, setMemo] = useState("");
  const [note, setNote] = useState("");
  const [attachmentName, setAttachmentName] = useState("");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState("");
  const [originalAmount, setOriginalAmount] = useState("");
  const [expenseAccountId, setExpenseAccountId] = useState("");
  const [prepaidAccountId, setPrepaidAccountId] = useState("");
  const [liabilityAccountId, setLiabilityAccountId] = useState("");
  const [revenueAccountId, setRevenueAccountId] = useState("");
  const [sourcePaymentId, setSourcePaymentId] = useState("");
  const [jobId, setJobId] = useState("");
  const [recognitionMethod, setRecognitionMethod] = useState("straight_line_monthly");
  const [autoReverse, setAutoReverse] = useState(false);
  const [reversalTiming, setReversalTiming] = useState("next_period");
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!editScheduleId) return;
    void fetch(`/api/accounting/schedules/${editScheduleId}`)
      .then((r) => r.json())
      .then((data: { schedule?: Record<string, unknown>; error?: string }) => {
        const schedule = data.schedule;
        if (!schedule) throw new Error(data.error || "Schedule not found");
        setLoadedType(schedule.schedule_type as ScheduleType);
        setName(String(schedule.name ?? ""));
        setReference(String(schedule.reference ?? ""));
        setMemo(String(schedule.memo ?? ""));
        setStartDate(String(schedule.start_date ?? "").slice(0, 10));
        setEndDate(String(schedule.end_date ?? "").slice(0, 10));
        setOriginalAmount(String(schedule.original_amount ?? ""));
        setExpenseAccountId(String(schedule.expense_account_id ?? ""));
        setPrepaidAccountId(String(schedule.prepaid_account_id ?? ""));
        setLiabilityAccountId(String(schedule.liability_account_id ?? ""));
        setRevenueAccountId(String(schedule.revenue_account_id ?? ""));
        setSourcePaymentId(String(schedule.source_payment_id ?? ""));
        setJobId(String(schedule.job_id ?? ""));
        setRecognitionMethod(String(schedule.recognition_method ?? "straight_line_monthly"));
        setAutoReverse(Boolean(schedule.auto_reverse));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Load failed"));
  }, [editScheduleId]);

  useEffect(() => {
    if (!scheduleType) return;
    void Promise.all([
      fetch("/api/accounts").then((r) => r.json()),
      fetch("/api/jobs").then((r) => r.json()),
      scheduleType === "deferred_revenue"
        ? fetch("/api/accounting/schedules/deposit-sources").then((r) => r.json())
        : Promise.resolve({ sources: [] }),
    ]).then(([accountsData, jobsData, depositData]) => {
      const acctList = (accountsData.accounts ?? []) as AccountOption[];
      setAccounts(acctList);
      setJobs((jobsData.jobs ?? []) as JobOption[]);
      setDeposits((depositData.sources ?? []) as DepositSource[]);
      const byCode = (code: string) => acctList.find((a) => a.code === code)?.id ?? "";
      setPrepaidAccountId(byCode("1300"));
      setExpenseAccountId(byCode("6100"));
      setLiabilityAccountId(byCode("2400"));
      setRevenueAccountId(byCode("4000"));
    });
  }, [scheduleType]);

  const selectedDeposit = useMemo(
    () => deposits.find((d) => d.paymentId === sourcePaymentId),
    [deposits, sourcePaymentId],
  );

  useEffect(() => {
    if (!scheduleType || !originalAmount) {
      void Promise.resolve().then(() => setPreview([]));
      return;
    }
    if (scheduleType === "accrued_expense") {
      void fetch("/api/accounting/schedules/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scheduleType,
          startDate,
          endDate: endDate || null,
          originalAmount: Number(originalAmount),
          recognitionMethod,
        }),
      })
        .then((r) => r.json())
        .then((data: { preview?: PreviewRow[] }) => setPreview(data.preview ?? []));
      return;
    }
    if (!endDate) {
      void Promise.resolve().then(() => setPreview([]));
      return;
    }
    void fetch("/api/accounting/schedules/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scheduleType,
        startDate,
        endDate,
        originalAmount: Number(originalAmount),
        recognitionMethod,
      }),
    })
      .then((r) => r.json())
      .then((data: { preview?: PreviewRow[]; error?: string }) => setPreview(data.preview ?? []));
  }, [scheduleType, startDate, endDate, originalAmount, recognitionMethod]);

  async function saveDraft(activate: boolean) {
    setPending(true);
    setError("");
    try {
      const body = {
        scheduleType,
        name,
        reference,
        memo,
        startDate,
        endDate: scheduleType === "accrued_expense" ? endDate || null : endDate,
        originalAmount: Number(originalAmount),
        expenseAccountId,
        prepaidAccountId,
        liabilityAccountId,
        revenueAccountId,
        sourcePaymentId: sourcePaymentId || null,
        jobId: jobId || null,
        recognitionMethod,
        autoReverse,
        reversalTiming: autoReverse ? reversalTiming : null,
        depositAvailable: selectedDeposit?.availableForSchedule ?? null,
        depositApplied: selectedDeposit?.appliedAmount ?? null,
      };

      let scheduleId = editScheduleId;
      if (editScheduleId) {
        const response = await fetch(`/api/accounting/schedules/${editScheduleId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await response.json()) as { schedule?: { id: string }; error?: string };
        if (!response.ok) throw new Error(data.error || "Could not update schedule");
      } else {
        const response = await fetch("/api/accounting/schedules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await response.json()) as { schedule?: { id: string }; error?: string };
        if (!response.ok) throw new Error(data.error || "Could not save schedule");
        scheduleId = data.schedule!.id;
      }

      if (!scheduleId) throw new Error("Schedule id missing");
      if (note.trim()) {
        await fetch(`/api/accounting/schedules/${scheduleId}/notes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ noteText: note.trim() }),
        });
      }
      if (attachmentName.trim()) {
        await fetch(`/api/accounting/schedules/${scheduleId}/attachments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: attachmentName.trim(), storagePath: `schedules/${scheduleId}/${attachmentName.trim()}` }),
        });
      }

      if (activate) {
        const activateRes = await fetch(`/api/accounting/schedules/${scheduleId}/lifecycle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "activate" }),
        });
        const activateData = (await activateRes.json()) as { error?: string };
        if (!activateRes.ok) throw new Error(activateData.error || "Could not activate");
      }

      router.push(scheduleDetailPath(scheduleId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setPending(false);
    }
  }

  if (!scheduleType) {
    return <div className="p-6 text-sm text-muted-foreground">Loading schedule…</div>;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <Link className="text-sm text-muted-foreground hover:underline" href={editScheduleId ? scheduleDetailPath(editScheduleId) : routes.accountingSchedules}>
        ← {editScheduleId ? "Schedule" : "Schedules"}
      </Link>
      <h1 className="text-2xl font-semibold">{editScheduleId ? "Edit" : "New"} {TYPE_LABELS[scheduleType]}</h1>

      {!editScheduleId ? (
      <div className="flex flex-wrap gap-2 text-sm">
        {(["prepaid_expense", "accrued_expense", "deferred_revenue"] as ScheduleType[]).map((type) => (
          <Link
            key={type}
            href={scheduleNewPath(type)}
            className={`rounded-md border px-3 py-1 ${type === scheduleType ? "border-navy bg-navy text-white" : "border-rule"}`}
          >
            {TYPE_LABELS[type]}
          </Link>
        ))}
      </div>
      ) : null}

      {scheduleType === "deferred_revenue" ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          {DEFERRED_REVENUE_V1_NOTE}
        </p>
      ) : null}

      {scheduleType === "accrued_expense" ? (
        <p className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950">
          Creates an accrual journal — this does not create a vendor bill.
        </p>
      ) : null}

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      <form
        className="space-y-4 rounded-lg border border-rule bg-paper-strong p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void saveDraft(false);
        }}
      >
        <label className="block text-sm">
          Name
          <input className="mt-1 w-full rounded-md border border-rule px-3 py-2" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="block text-sm">
          Reference / vendor
          <input className="mt-1 w-full rounded-md border border-rule px-3 py-2" value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
        <label className="block text-sm">
          Memo
          <input className="mt-1 w-full rounded-md border border-rule px-3 py-2" value={memo} onChange={(e) => setMemo(e.target.value)} />
        </label>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm">
            Start date
            <input type="date" className="mt-1 w-full rounded-md border border-rule px-3 py-2" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </label>
          {scheduleType !== "accrued_expense" ? (
            <label className="block text-sm">
              End date
              <input type="date" className="mt-1 w-full rounded-md border border-rule px-3 py-2" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
            </label>
          ) : (
            <label className="block text-sm">
              End date (optional)
              <input type="date" className="mt-1 w-full rounded-md border border-rule px-3 py-2" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </label>
          )}
        </div>

        <label className="block text-sm">
          {scheduleType === "accrued_expense" ? "Accrual amount" : "Original amount"}
          <input type="number" step="0.01" min="0" className="mt-1 w-full rounded-md border border-rule px-3 py-2" value={originalAmount} onChange={(e) => setOriginalAmount(e.target.value)} required />
        </label>

        {scheduleType === "prepaid_expense" ? (
          <>
            <label className="block text-sm">
              Prepaid asset account
              <select className="mt-1 w-full rounded-md border border-rule px-3 py-2" value={prepaidAccountId} onChange={(e) => setPrepaidAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              Expense account
              <select className="mt-1 w-full rounded-md border border-rule px-3 py-2" value={expenseAccountId} onChange={(e) => setExpenseAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              Recognition method
              <select className="mt-1 w-full rounded-md border border-rule px-3 py-2" value={recognitionMethod} onChange={(e) => setRecognitionMethod(e.target.value)}>
                <option value="straight_line_monthly">Straight-line monthly</option>
                <option value="full_month">Full month</option>
                <option value="next_full_month">Next full month</option>
              </select>
            </label>
          </>
        ) : null}

        {scheduleType === "accrued_expense" ? (
          <>
            <label className="block text-sm">
              Expense account
              <select className="mt-1 w-full rounded-md border border-rule px-3 py-2" value={expenseAccountId} onChange={(e) => setExpenseAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              Accrued liability account
              <select className="mt-1 w-full rounded-md border border-rule px-3 py-2" value={liabilityAccountId} onChange={(e) => setLiabilityAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={autoReverse} onChange={(e) => setAutoReverse(e.target.checked)} />
              Auto-reverse next period
            </label>
            {autoReverse ? (
              <label className="block text-sm">
                Reversal timing
                <select className="mt-1 w-full rounded-md border border-rule px-3 py-2" value={reversalTiming} onChange={(e) => setReversalTiming(e.target.value)}>
                  <option value="next_period">First day of next period</option>
                  <option value="same_day_next_month">Same day next month</option>
                </select>
              </label>
            ) : null}
          </>
        ) : null}

        {scheduleType === "deferred_revenue" ? (
          <>
            <label className="block text-sm">
              Customer deposit source
              <select className="mt-1 w-full rounded-md border border-rule px-3 py-2" value={sourcePaymentId} onChange={(e) => setSourcePaymentId(e.target.value)} required>
                <option value="">Select deposit…</option>
                {deposits.map((d) => (
                  <option key={d.paymentId} value={d.paymentId} disabled={d.fullyApplied}>
                    {d.paymentDate} — {money(d.availableForSchedule)} available ({d.memo || "deposit"})
                  </option>
                ))}
              </select>
            </label>
            {selectedDeposit ? (
              <div className="rounded-md border border-rule bg-white p-3 text-sm">
                <p>Original deposit: {money(selectedDeposit.originalAmount)}</p>
                <p>Already applied/recognized: {money(selectedDeposit.appliedAmount)}</p>
                <p>Available for schedule: {money(selectedDeposit.availableForSchedule)}</p>
              </div>
            ) : null}
            <label className="block text-sm">
              Deposit liability account
              <select className="mt-1 w-full rounded-md border border-rule px-3 py-2" value={liabilityAccountId} onChange={(e) => setLiabilityAccountId(e.target.value)}>
                {accounts.filter((a) => a.code === "2300" || a.name.toLowerCase().includes("deposit")).map((a) => (
                  <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              Revenue account
              <select className="mt-1 w-full rounded-md border border-rule px-3 py-2" value={revenueAccountId} onChange={(e) => setRevenueAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                ))}
              </select>
            </label>
          </>
        ) : null}

        <label className="block text-sm">
          Job (optional)
          <select className="mt-1 w-full rounded-md border border-rule px-3 py-2" value={jobId} onChange={(e) => setJobId(e.target.value)}>
            <option value="">None</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>{j.name}</option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          Accountant note
          <textarea className="mt-1 w-full rounded-md border border-rule px-3 py-2" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <label className="block text-sm">
          Attachment filename (metadata)
          <input className="mt-1 w-full rounded-md border border-rule px-3 py-2" value={attachmentName} onChange={(e) => setAttachmentName(e.target.value)} placeholder="policy.pdf" />
        </label>

        {preview.length ? (
          <div>
            <h2 className="font-medium">Recognition preview</h2>
            <table className="report-table mt-2">
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="text-right">Amount</th>
                  <th className="text-right">Remaining</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((row) => (
                  <tr key={row.occurrenceDate}>
                    <td>{row.occurrenceDate}{row.isFinal ? " (final)" : ""}</td>
                    <td className="text-right">{money(row.amount)}</td>
                    <td className="text-right">{money(row.remainingAfter)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2 pt-2">
          <button type="submit" disabled={pending} className="rounded-md border border-rule px-4 py-2 text-sm">
            Save draft
          </button>
          <button type="button" disabled={pending} onClick={() => void saveDraft(true)} className="rounded-md bg-navy px-4 py-2 text-sm text-white">
            Save & activate
          </button>
        </div>
      </form>
    </div>
  );
}
