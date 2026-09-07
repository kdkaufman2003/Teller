"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { money } from "@/lib/format";
import {
  routes,
  scheduleNewPath,
  scheduleOccurrencePath,
} from "@/lib/routes";

type Schedule = Record<string, unknown> & {
  id: string;
  name: string;
  status: string;
  schedule_type: string;
  original_amount: number;
  remaining_amount: number;
  start_date: string;
  end_date: string | null;
  next_occurrence_date: string | null;
  reference?: string;
  memo?: string;
};

type Occurrence = {
  id: string;
  occurrence_date: string;
  amount: number;
  status: string;
  journal_entry_id: string | null;
};

type PreviewRow = { occurrenceDate: string; amount: number; remainingAfter: number; isFinal: boolean };

const TYPE_LABELS: Record<string, string> = {
  prepaid_expense: "Prepaid expense",
  accrued_expense: "Accrued expense",
  deferred_revenue: "Deferred revenue",
};

export function ScheduleDetailView({
  scheduleId,
  canWrite,
}: {
  scheduleId: string;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [occurrences, setOccurrences] = useState<Occurrence[]>([]);
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [editName, setEditName] = useState("");
  const [editMemo, setEditMemo] = useState("");

  const load = useCallback(async () => {
    const response = await fetch(`/api/accounting/schedules/${scheduleId}`);
    const data = (await response.json()) as {
      schedule?: Schedule;
      occurrences?: Occurrence[];
      error?: string;
    };
    if (!response.ok) throw new Error(data.error || "Could not load schedule");
    setSchedule(data.schedule ?? null);
    setOccurrences(data.occurrences ?? []);
    if (data.schedule) {
      setEditName(data.schedule.name);
      setEditMemo(String(data.schedule.memo ?? ""));
    }
  }, [scheduleId]);

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Load failed"));
  }, [load]);

  useEffect(() => {
    if (!schedule || schedule.status !== "draft") return;
    void fetch(`/api/accounting/schedules/${scheduleId}/preview`)
      .then((r) => r.json())
      .then((data: { preview?: PreviewRow[] }) => setPreview(data.preview ?? []));
  }, [schedule, scheduleId]);

  async function lifecycle(action: string) {
    setPending(action);
    setError("");
    try {
      const response = await fetch(`/api/accounting/schedules/${scheduleId}/lifecycle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || "Action failed");
      await load();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setPending("");
    }
  }

  async function saveDraft() {
    setPending("save");
    setError("");
    try {
      const response = await fetch(`/api/accounting/schedules/${scheduleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName, memo: editMemo }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || "Could not save");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setPending("");
    }
  }

  if (!schedule) {
    return (
      <div className="p-6">
        {error ? <p className="text-sm text-red-700">{error}</p> : <p className="text-sm text-muted-foreground">Loading…</p>}
      </div>
    );
  }

  const isDraft = schedule.status === "draft";
  const isPaused = schedule.status === "paused";
  const isActive = schedule.status === "active";
  const canEdit = canWrite && (isDraft || isPaused);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <Link className="text-sm text-muted-foreground hover:underline" href={routes.accountingSchedules}>
        ← Schedules
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{schedule.name}</h1>
          <p className="text-sm text-muted-foreground">
            {TYPE_LABELS[schedule.schedule_type] ?? schedule.schedule_type} ·{" "}
            <span className="capitalize">{schedule.status}</span>
          </p>
        </div>
        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            {isDraft ? (
              <>
                <Link
                  href={`${routes.accountingSchedules}/${scheduleId}/edit`}
                  className="rounded-md border border-rule px-4 py-2 text-sm"
                >
                  Edit draft
                </Link>
                <button
                  type="button"
                  disabled={Boolean(pending)}
                  onClick={() => void lifecycle("activate")}
                  className="rounded-md bg-navy px-4 py-2 text-sm text-white disabled:opacity-60"
                >
                  Activate
                </button>
              </>
            ) : null}
            {isActive ? (
              <button type="button" disabled={Boolean(pending)} onClick={() => void lifecycle("pause")} className="rounded-md border border-rule px-4 py-2 text-sm">
                Pause
              </button>
            ) : null}
            {isPaused ? (
              <button type="button" disabled={Boolean(pending)} onClick={() => void lifecycle("resume")} className="rounded-md bg-navy px-4 py-2 text-sm text-white">
                Resume
              </button>
            ) : null}
            {isActive || isPaused || isDraft ? (
              <button type="button" disabled={Boolean(pending)} onClick={() => void lifecycle("cancel")} className="rounded-md border border-red-300 px-4 py-2 text-sm text-red-800">
                Cancel
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      <section className="grid gap-4 rounded-lg border border-rule bg-paper-strong p-5 md:grid-cols-3">
        <div>
          <p className="text-xs uppercase text-muted">Original</p>
          <p className="font-ledger text-xl">{money(Number(schedule.original_amount))}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-muted">Remaining</p>
          <p className="font-ledger text-xl">{money(Number(schedule.remaining_amount))}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-muted">Next occurrence</p>
          <p className="font-ledger text-xl">{schedule.next_occurrence_date ?? "—"}</p>
        </div>
      </section>

      {canEdit ? (
        <section className="space-y-3 rounded-lg border border-rule p-5">
          <h2 className="font-medium">Edit schedule</h2>
          {isPaused ? (
            <p className="text-sm text-muted-foreground">Paused schedules allow limited edits (name, memo, end date).</p>
          ) : null}
          <label className="block text-sm">
            Name
            <input className="mt-1 w-full rounded-md border border-rule px-3 py-2" value={editName} onChange={(e) => setEditName(e.target.value)} />
          </label>
          <label className="block text-sm">
            Memo
            <input className="mt-1 w-full rounded-md border border-rule px-3 py-2" value={editMemo} onChange={(e) => setEditMemo(e.target.value)} />
          </label>
          <button type="button" disabled={pending === "save"} onClick={() => void saveDraft()} className="rounded-md border border-rule px-4 py-2 text-sm">
            Save changes
          </button>
        </section>
      ) : null}

      {isDraft && preview.length ? (
        <section>
          <h2 className="font-medium">Activation preview</h2>
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
        </section>
      ) : null}

      <section>
        <h2 className="font-medium">Occurrences</h2>
        <table className="report-table mt-2">
          <thead>
            <tr>
              <th>Date</th>
              <th>Status</th>
              <th className="text-right">Amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {occurrences.map((row) => (
              <tr key={row.id}>
                <td>{row.occurrence_date}</td>
                <td className="capitalize">{row.status}</td>
                <td className="text-right">{money(Number(row.amount))}</td>
                <td className="text-right">
                  <Link href={scheduleOccurrencePath(scheduleId, row.id)} className="text-sm text-sky hover:underline">
                    Review
                  </Link>
                </td>
              </tr>
            ))}
            {!occurrences.length ? (
              <tr>
                <td colSpan={4} className="py-4 text-muted-foreground">
                  {isDraft ? "Occurrences are generated when the schedule is activated." : "No occurrences yet."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export function ScheduleListSection({
  scheduleType,
  title,
  newType,
}: {
  scheduleType: string;
  title: string;
  newType: string;
}) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [schemaReady, setSchemaReady] = useState(true);

  useEffect(() => {
    void fetch(`/api/accounting/schedules?type=${encodeURIComponent(scheduleType)}`)
      .then((r) => r.json())
      .then((data: { schedules?: Schedule[]; schemaReady?: boolean }) => {
        setSchedules(data.schedules ?? []);
        setSchemaReady(data.schemaReady !== false);
      });
  }, [scheduleType]);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <Link className="text-sm text-muted-foreground hover:underline" href={routes.accountingSchedules}>
        ← Schedules
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <Link href={scheduleNewPath(newType)} className="rounded-md bg-navy px-4 py-2 text-sm text-white">
          New schedule
        </Link>
      </div>
      {!schemaReady ? (
        <p className="text-sm text-amber-700">Apply migration 027 to enable schedule storage.</p>
      ) : null}
      <table className="report-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th className="text-right">Remaining</th>
            <th>Next</th>
          </tr>
        </thead>
        <tbody>
          {schedules.map((row) => (
            <tr key={row.id}>
              <td>
                <Link href={`${routes.accountingSchedules}/${row.id}`} className="text-sky hover:underline">
                  {row.name}
                </Link>
              </td>
              <td className="capitalize">{row.status}</td>
              <td className="text-right">{money(Number(row.remaining_amount))}</td>
              <td>{row.next_occurrence_date ?? "—"}</td>
            </tr>
          ))}
          {!schedules.length ? (
            <tr>
              <td colSpan={4} className="py-4 text-muted-foreground">
                No schedules yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
