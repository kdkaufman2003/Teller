"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { IntelligenceReport } from "@/lib/intelligence/types";

export function IntelligencePanel({
  report,
  canManage,
}: {
  report: IntelligenceReport;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");

  async function runScan() {
    setPending("scan");
    setError("");
    try {
      const response = await fetch("/api/intelligence", { method: "POST" });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Scan failed");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setPending("");
    }
  }

  async function resolveSuggestion(id: string, status: "accepted" | "dismissed") {
    setPending(id);
    setError("");
    try {
      const response = await fetch(`/api/intelligence/suggestions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not update suggestion");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update suggestion");
    } finally {
      setPending("");
    }
  }

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.14em] text-muted">Intelligence</p>
          <h2 className="font-ledger text-2xl text-navy">What your numbers mean</h2>
          <p className="mt-1 text-sm text-muted">
            Rule-based insights and review suggestions — nothing posts to the ledger without you.
          </p>
        </div>
        {canManage ? (
          <button
            type="button"
            onClick={runScan}
            disabled={Boolean(pending)}
            className="btn btn-secondary text-sm"
          >
            {pending === "scan" ? "Scanning…" : "Run scan"}
          </button>
        ) : null}
      </div>

      {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}

      <div className="mt-5 space-y-2">
        {report.narrative.map((line) => (
          <p key={line} className="text-sm text-ink">
            {line}
          </p>
        ))}
      </div>

      {report.insights.length > 0 ? (
        <div className="mt-6 grid gap-2 md:grid-cols-2">
          {report.insights.map((insight) => (
            <article
              key={insight.id}
              className={`rounded-lg border px-4 py-3 text-sm ${
                insight.tone === "warning"
                  ? "border-amber-200 bg-amber-50"
                  : insight.tone === "positive"
                    ? "border-emerald-200 bg-emerald-50"
                    : "border-rule bg-paper-strong"
              }`}
            >
              <p className="font-medium">{insight.title}</p>
              <p className="mt-1 text-muted">{insight.description}</p>
            </article>
          ))}
        </div>
      ) : null}

      {report.suggestions.length > 0 ? (
        <div className="mt-6 border-t border-rule pt-5">
          <h3 className="font-ledger text-lg text-navy">
            Suggestions to review ({report.pendingCount})
          </h3>
          <ul className="mt-3 space-y-2">
            {report.suggestions.map((item) => (
              <li
                key={item.id ?? item.fingerprint}
                className="rounded-lg border border-rule bg-paper-strong px-4 py-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.14em] text-muted">{item.kind}</p>
                    <p className="font-medium">{item.title}</p>
                    <p className="mt-1 text-sm text-muted">{item.description}</p>
                    {item.href ? (
                      <Link href={item.href} className="mt-2 inline-block text-sm text-sky">
                        Review
                      </Link>
                    ) : null}
                  </div>
                  {canManage && item.id ? (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="text-sm text-muted hover:text-ink"
                        disabled={Boolean(pending)}
                        onClick={() => resolveSuggestion(item.id!, "dismissed")}
                      >
                        Dismiss
                      </button>
                      <button
                        type="button"
                        className="text-sm text-sky"
                        disabled={Boolean(pending)}
                        onClick={() => resolveSuggestion(item.id!, "accepted")}
                      >
                        Helpful
                      </button>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : canManage ? (
        <p className="mt-6 text-sm text-muted">
          Run a scan to generate categorization, reconciliation, and anomaly suggestions.
        </p>
      ) : null}

      {report.aiEnabled ? (
        <p className="mt-4 text-xs text-muted">Receipt AI is enabled for this workspace.</p>
      ) : null}
    </section>
  );
}
