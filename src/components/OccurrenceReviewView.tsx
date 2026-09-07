"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { money } from "@/lib/format";
import { ledgerEntryPath, routes, scheduleDetailPath } from "@/lib/routes";
import type { OccurrenceDetail } from "@/lib/accounting/schedules/occurrence-workflow";

export function OccurrenceReviewView({
  scheduleId,
  occurrenceId,
  canWrite,
  closedThrough,
}: {
  scheduleId: string;
  occurrenceId: string;
  canWrite: boolean;
  closedThrough: string | null;
}) {
  const router = useRouter();
  const [detail, setDetail] = useState<OccurrenceDetail | null>(null);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [skipReason, setSkipReason] = useState("");

  useEffect(() => {
    void fetch(`/api/accounting/schedules/occurrences/${occurrenceId}`)
      .then((r) => r.json())
      .then((data: { occurrence?: OccurrenceDetail; error?: string }) => {
        if (!data.occurrence) throw new Error(data.error || "Not found");
        setDetail(data.occurrence);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Load failed"));
  }, [occurrenceId]);

  const periodClosed =
    closedThrough != null &&
    detail != null &&
    detail.occurrenceDate.slice(0, 10) <= closedThrough.slice(0, 10);

  async function action(name: string, body: Record<string, string> = {}) {
    setPending(name);
    setError("");
    try {
      const response = await fetch(`/api/accounting/schedules/occurrences/${occurrenceId}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: name, ...body }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || "Action failed");
      router.refresh();
      const reload = await fetch(`/api/accounting/schedules/occurrences/${occurrenceId}`);
      const reloadData = (await reload.json()) as { occurrence?: OccurrenceDetail };
      setDetail(reloadData.occurrence ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setPending("");
    }
  }

  if (!detail) {
    return <div className="p-6">{error ? <p className="text-sm text-red-700">{error}</p> : <p>Loading…</p>}</div>;
  }

  const schedule = detail.schedule as Record<string, unknown>;
  const scheduleName = String(schedule.name ?? "Schedule");
  const scheduleType = String(schedule.schedule_type ?? "");

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <Link className="text-sm text-muted-foreground hover:underline" href={scheduleDetailPath(scheduleId)}>
        ← {scheduleName}
      </Link>
      <h1 className="text-2xl font-semibold">Review occurrence</h1>

      {periodClosed ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          Books are closed through {closedThrough}. Posting to this accounting date is blocked.
        </p>
      ) : null}

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      <section className="space-y-3 rounded-lg border border-rule bg-paper-strong p-5 text-sm">
        <div className="grid gap-3 md:grid-cols-2">
          <p><span className="text-muted">Due date</span><br />{detail.occurrenceDate}</p>
          <p><span className="text-muted">Period end</span><br />{detail.periodEnd}</p>
          <p><span className="text-muted">Amount</span><br />{money(detail.amount)}</p>
          <p><span className="text-muted">Status</span><br /><span className="capitalize">{detail.status}</span></p>
          <p><span className="text-muted">Schedule</span><br />{scheduleName} ({scheduleType.replace(/_/g, " ")})</p>
          <p><span className="text-muted">Debit account</span><br />{detail.debitAccountId}</p>
          <p><span className="text-muted">Credit account</span><br />{detail.creditAccountId}</p>
        </div>
        {detail.failureReason ? (
          <p className="text-red-800">Failure: {detail.failureReason}</p>
        ) : null}
        {detail.journalEntryId ? (
          <p>
            Journal:{" "}
            <Link href={ledgerEntryPath(detail.journalEntryId)} className="text-sky hover:underline">
              View entry
            </Link>
          </p>
        ) : null}
      </section>

      {canWrite && !periodClosed ? (
        <section className="flex flex-wrap gap-2">
          {["scheduled", "generated"].includes(detail.status) ? (
            <button type="button" disabled={Boolean(pending)} onClick={() => void action("approve")} className="rounded-md border border-rule px-4 py-2 text-sm">
              Approve
            </button>
          ) : null}
          {["scheduled", "generated", "approved"].includes(detail.status) ? (
            <button type="button" disabled={Boolean(pending)} onClick={() => void action("post")} className="rounded-md bg-navy px-4 py-2 text-sm text-white">
              Post
            </button>
          ) : null}
          {detail.status === "failed" ? (
            <button type="button" disabled={Boolean(pending)} onClick={() => void action("retry")} className="rounded-md border border-rule px-4 py-2 text-sm">
              Retry
            </button>
          ) : null}
          {detail.status === "posted" ? (
            <button
              type="button"
              disabled={Boolean(pending)}
              onClick={() => void action("reverse", { reversalDate: detail.occurrenceDate })}
              className="rounded-md border border-rule px-4 py-2 text-sm"
            >
              Reverse
            </button>
          ) : null}
        </section>
      ) : null}

      {canWrite && ["scheduled", "generated", "approved", "failed"].includes(detail.status) ? (
        <section className="space-y-2 rounded-lg border border-rule p-4">
          <label className="block text-sm">
            Skip with reason
            <input className="mt-1 w-full rounded-md border border-rule px-3 py-2" value={skipReason} onChange={(e) => setSkipReason(e.target.value)} />
          </label>
          <button
            type="button"
            disabled={Boolean(pending) || !skipReason.trim()}
            onClick={() => void action("skip", { reason: skipReason })}
            className="rounded-md border border-rule px-4 py-2 text-sm"
          >
            Skip occurrence
          </button>
        </section>
      ) : null}

      <Link href={routes.accountingSchedules} className="text-sm text-muted-foreground hover:underline">
        All schedules
      </Link>
    </div>
  );
}
