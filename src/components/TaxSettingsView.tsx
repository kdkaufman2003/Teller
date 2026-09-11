"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TaxNav } from "@/components/TaxNav";
import { routes } from "@/lib/routes";
import { ownerSetupStatusLabel } from "@/lib/accounting/tax/readiness";
import { statePackStatusLabel } from "@/lib/accounting/tax/owner";

type TaxSettingsPayload = {
  settings: {
    salesTaxPayableAccountId?: string | null;
    roundingPolicy: string;
    setupStatus: string;
  };
  schemaReady: boolean;
  readiness: {
    status: string;
    checks: Array<{ key: string; label: string; ownerLabel: string; passed: boolean }>;
  };
  liabilityAccounts: Array<{ id: string; code: string; name: string; subtype?: string | null }>;
  registrations: Array<{
    id: string;
    jurisdiction_key?: string | null;
    status: string;
    metadata?: { statePackId?: string; statePackVersion?: string; statePackActivatedAt?: string };
  }>;
};

export function TaxSettingsView() {
  const [payload, setPayload] = useState<TaxSettingsPayload | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetch("/api/settings/tax")
      .then((response) => response.json())
      .then((data) => setPayload(data));
  }, []);

  async function save() {
    if (!payload) return;
    setSaving(true);
    setMessage("");
    const response = await fetch("/api/settings/tax", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        salesTaxPayableAccountId: payload.settings.salesTaxPayableAccountId,
        roundingPolicy: payload.settings.roundingPolicy,
      }),
    });
    const data = await response.json();
    setSaving(false);
    if (!response.ok) {
      setMessage(data.error || "Save failed");
      return;
    }
    setPayload(data);
    setMessage("Saved.");
  }

  if (!payload) return <p className="text-muted p-6">Loading…</p>;

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <TaxNav />

      <header className="page-header">
        <h1>Tax settings</h1>
        <p className="text-muted">
          Configure sales tax accounting. Teller calculates and tracks tax obligations — it does not file
          returns or provide tax advice.
        </p>
        <Link href={routes.taxSettings} className="text-sm underline">
          Back to tax overview
        </Link>
      </header>

      {!payload.schemaReady ? (
        <div className="card border-amber-200 bg-amber-50 p-4 text-sm">
          Tax accounting schema is not available in this environment yet. Migration{" "}
          <code>035_phase15_tax_accounting.sql</code> must be manually applied before tax settings can be
          saved.
        </div>
      ) : null}

      <div className="card space-y-3 p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-medium">Sales Tax Setup</h2>
            <p className="text-muted text-sm">Status: {ownerSetupStatusLabel(payload.readiness.status as "not_configured" | "needs_review" | "configured")}</p>
          </div>
          <div className="flex flex-col items-end gap-1 text-sm">
            <Link href={routes.taxExemptions} className="underline">
              Exemptions
            </Link>
            <Link href={routes.taxPeriods} className="underline">
              Filing periods
            </Link>
            <Link href={routes.taxReports} className="underline">
              Reports
            </Link>
          </div>
        </div>
        <ul className="space-y-2 text-sm">
          {payload.readiness.checks.map((check) => (
            <li key={check.key} className="flex items-center justify-between gap-3">
              <span>{check.ownerLabel}</span>
              <span className={check.passed ? "text-green-700" : "text-amber-700"}>
                {check.passed ? "Ready" : "Needs attention"}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="card space-y-4 p-4">
        <h2 className="font-medium">Tax Accounting</h2>
        <label className="block space-y-1">
          <span className="text-sm">Tax Payable account</span>
          <select
            className="input w-full"
            value={payload.settings.salesTaxPayableAccountId ?? ""}
            onChange={(e) =>
              setPayload({
                ...payload,
                settings: {
                  ...payload.settings,
                  salesTaxPayableAccountId: e.target.value || null,
                },
              })
            }
          >
            <option value="">Select Sales & Use Tax Payable…</option>
            {payload.liabilityAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} — {account.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-sm">Rounding policy</span>
          <select
            className="input w-full"
            value={payload.settings.roundingPolicy}
            onChange={(e) =>
              setPayload({
                ...payload,
                settings: { ...payload.settings, roundingPolicy: e.target.value },
              })
            }
          >
            <option value="per_line">Per line</option>
            <option value="per_component">Per component</option>
            <option value="per_document">Per document</option>
          </select>
        </label>

        <button type="button" className="btn btn-primary" disabled={saving || !payload.schemaReady} onClick={() => void save()}>
          {saving ? "Saving…" : "Save tax settings"}
        </button>
        {message ? <p className="text-sm">{message}</p> : null}
      </div>

      <div className="card space-y-2 p-4">
        <h2 className="font-medium">Active Tax States</h2>
        {payload.registrations.filter((r) => r.status === "active").length === 0 ? (
          <p className="text-muted text-sm">No active state tax registrations yet.</p>
        ) : (
          <ul className="text-sm">
            {payload.registrations
              .filter((registration) => registration.status === "active")
              .map((registration) => {
                const state = registration.jurisdiction_key?.split("-")[1] ?? registration.jurisdiction_key;
                const packActive = Boolean(
                  registration.metadata?.statePackActivatedAt || registration.metadata?.statePackVersion,
                );
                return (
                  <li key={registration.id}>
                    {state} —{" "}
                    {packActive
                      ? statePackStatusLabel("active")
                      : statePackStatusLabel("needs_setup")}
                  </li>
                );
              })}
          </ul>
        )}
        <p className="text-muted text-xs">
          Missouri and Kansas reference packs are available via Tax → Activate State Pack (accountant setup).
        </p>
      </div>
    </div>
  );
}
