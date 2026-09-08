"use client";

import { useState } from "react";
import { money } from "@/lib/format";
import type { BudgetCsvImportMode } from "@/lib/planning/budgets/types";

type PreviewPayload = {
  matched: Array<{ rowNumber: number; accountCode: string; accountName: string }>;
  unmatched: Array<{ rowNumber: number; message: string }>;
  errors: Array<{ rowNumber: number; message: string }>;
  warnings: Array<{ rowNumber: number; message: string }>;
  lineCount: number;
  annualTotal: number;
  accountsMatched: number;
  accountsUnmatched: number;
};

export function BudgetImportPanel({
  budgetId,
  versionId,
  editable,
  onImported,
}: {
  budgetId: string;
  versionId: string;
  editable: boolean;
  onImported: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [filename, setFilename] = useState("");
  const [mode, setMode] = useState<BudgetCsvImportMode>("replace");
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");

  async function loadFile(file: File) {
    setError("");
    setPreview(null);
    setFilename(file.name);
    const text = await file.text();
    setCsv(text);
  }

  async function runPreview() {
    if (!csv.trim()) {
      setError("Choose a CSV file first");
      return;
    }
    setPending("preview");
    setError("");
    try {
      const response = await fetch(
        `/api/planning/budgets/${budgetId}/versions/${versionId}/import/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ csv, filename }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Preview failed");
      setPreview(data.preview as PreviewPayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
      setPreview(null);
    } finally {
      setPending("");
    }
  }

  async function confirmImport() {
    if (!preview) return;
    setPending("confirm");
    setError("");
    try {
      const response = await fetch(
        `/api/planning/budgets/${budgetId}/versions/${versionId}/import/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ csv, filename, mode }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Import failed");
      setOpen(false);
      setCsv("");
      setPreview(null);
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setPending("");
    }
  }

  if (!editable) return null;

  return (
    <div>
      <button type="button" onClick={() => setOpen(true)} className="rounded-md border px-4 py-2 text-sm">
        Import CSV
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border bg-paper-strong p-6 shadow-lg">
            <h2 className="text-lg font-semibold">Import budget from CSV</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Upload, preview, then confirm. Only draft versions accept imports.
            </p>

            <div className="mt-4 space-y-3">
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void loadFile(file);
                }}
                className="block w-full text-sm"
              />

              <fieldset className="space-y-1 text-sm">
                <legend className="font-medium">Import mode</legend>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={mode === "replace"}
                    onChange={() => setMode("replace")}
                  />
                  Replace — overwrite matching account/month values from CSV
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={mode === "merge"}
                    onChange={() => setMode("merge")}
                  />
                  Merge — update only non-zero CSV values; keep other months
                </label>
              </fieldset>

              <button
                type="button"
                disabled={!!pending || !csv}
                onClick={() => void runPreview()}
                className="rounded-md border px-4 py-2 text-sm disabled:opacity-50"
              >
                {pending === "preview" ? "Validating…" : "Preview import"}
              </button>
            </div>

            {preview ? (
              <div className="mt-4 space-y-2 rounded-md border p-4 text-sm">
                <p>
                  <strong>{preview.accountsMatched}</strong> accounts matched ·{" "}
                  <strong>{preview.lineCount}</strong> lines · annual total{" "}
                  <span className="font-ledger">{money(preview.annualTotal)}</span>
                </p>
                {preview.accountsUnmatched ? (
                  <p className="text-amber-800">
                    {preview.accountsUnmatched} unmatched row(s) will be skipped
                  </p>
                ) : null}
                {preview.errors.map((issue) => (
                  <p key={`e-${issue.rowNumber}`} className="text-red-700">
                    Row {issue.rowNumber}: {issue.message}
                  </p>
                ))}
                {preview.unmatched.map((issue) => (
                  <p key={`u-${issue.rowNumber}`} className="text-amber-800">
                    Row {issue.rowNumber}: {issue.message}
                  </p>
                ))}
                {preview.warnings.map((issue) => (
                  <p key={`w-${issue.rowNumber}`} className="text-muted-foreground">
                    Row {issue.rowNumber}: {issue.message}
                  </p>
                ))}
              </div>
            ) : null}

            {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setPreview(null);
                  setError("");
                }}
                className="rounded-md border px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!!pending || !preview || (preview.errors?.length ?? 0) > 0}
                onClick={() => void confirmImport()}
                className="rounded-md bg-navy px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                {pending === "confirm" ? "Importing…" : "Confirm import"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
