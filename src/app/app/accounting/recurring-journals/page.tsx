"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { routes } from "@/lib/routes";

type Template = {
  id: string;
  name: string;
  memo: string;
  frequency: string;
  start_date: string;
  next_run_date: string | null;
  active: boolean;
};

export default function RecurringJournalsPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [generateForDate, setGenerateForDate] = useState(new Date().toISOString().slice(0, 10));
  const [pending, setPending] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function loadTemplates() {
    const response = await fetch("/api/accounting/recurring-journals");
    const data = (await response.json()) as { templates?: Template[]; error?: string };
    if (response.ok) setTemplates(data.templates ?? []);
  }

  useEffect(() => {
    void loadTemplates();
  }, []);

  async function generateDraft(templateId: string) {
    setPending(templateId);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/accounting/recurring-journals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId, generateForDate }),
      });
      const data = (await response.json()) as {
        error?: string;
        duplicate?: boolean;
        adjustment?: { id: string; adjustment_number?: string };
      };
      if (!response.ok) throw new Error(data.error || "Generate failed");
      setMessage(
        data.duplicate
          ? "Draft already exists for this date."
          : `Created draft ${data.adjustment?.adjustment_number ?? ""}.`.trim(),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generate failed");
    } finally {
      setPending("");
    }
  }

  return (
    <div className="space-y-6">
      <header className="page-header">
        <Link href={routes.accounting} className="text-sm text-muted">
          ← Accounting
        </Link>
        <h1 className="mt-2">Recurring journals</h1>
        <p className="text-muted">Generate adjusting entry drafts from templates.</p>
      </header>

      <div className="card flex flex-wrap items-end gap-4 p-4">
        <label className="space-y-1 text-sm">
          <span className="text-muted">Generate for date</span>
          <input
            type="date"
            className="input"
            value={generateForDate}
            onChange={(event) => setGenerateForDate(event.target.value)}
          />
        </label>
      </div>

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          {error}
        </p>
      ) : null}
      {message ? <p className="text-sm">{message}</p> : null}

      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Frequency</th>
              <th>Start</th>
              <th>Next run</th>
              <th>Active</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {templates.map((template) => (
              <tr key={template.id}>
                <td>{template.name}</td>
                <td className="capitalize">{template.frequency}</td>
                <td>{template.start_date}</td>
                <td>{template.next_run_date ?? "—"}</td>
                <td>{template.active ? "Yes" : "No"}</td>
                <td className="text-right">
                  <button
                    type="button"
                    className="btn text-sm"
                    disabled={Boolean(pending) || !template.active}
                    onClick={() => generateDraft(template.id)}
                  >
                    {pending === template.id ? "Generating…" : "Generate draft"}
                  </button>
                </td>
              </tr>
            ))}
            {!templates.length ? (
              <tr>
                <td colSpan={6} className="text-muted py-6 text-center">
                  No recurring journal templates yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
