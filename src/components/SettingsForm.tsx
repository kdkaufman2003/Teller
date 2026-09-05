"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ACCOUNTING_BASIS_OPTIONS } from "@/lib/industries/accounting-basis";
import { fiscalYearStartLabel } from "@/lib/org/config";
import type { TellerOrganization } from "@/types";

type SettingsPayload = {
  organization: TellerOrganization;
  settings: {
    answers: Record<string, unknown>;
    modules: string[];
    labels: Record<string, string>;
  };
};

const FISCAL_MONTHS = Array.from({ length: 12 }, (_, index) => ({
  value: String(index + 1),
  label: fiscalYearStartLabel(index + 1),
}));

export function SettingsForm({
  initialOrganization,
  initialAnswers,
  industryName,
  modules,
}: {
  initialOrganization: TellerOrganization;
  initialAnswers: Record<string, unknown>;
  industryName: string;
  modules: string[];
}) {
  const router = useRouter();
  const [org, setOrg] = useState({
    name: initialOrganization.name,
    legal_name: initialOrganization.legal_name,
    phone: initialOrganization.phone ?? "",
    timezone: initialOrganization.timezone ?? "America/Chicago",
    currency: initialOrganization.currency ?? "USD",
    address_line1: initialOrganization.address_line1 ?? "",
    city: initialOrganization.city ?? "",
    state: initialOrganization.state ?? "",
    postal_code: initialOrganization.postal_code ?? "",
    country: initialOrganization.country ?? "US",
  });
  const [basis, setBasis] = useState(String(initialAnswers.basis ?? "accrual"));
  const [fiscalYearStart, setFiscalYearStart] = useState(
    String(initialAnswers.fiscalYearStart ?? "1"),
  );
  const [collectTax, setCollectTax] = useState(
    initialAnswers.collectTax !== false &&
      initialAnswers.collectTax !== "false" &&
      initialAnswers.collectTax !== "no",
  );
  const [taxRate, setTaxRate] = useState(String(initialAnswers.taxRate ?? "0"));
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setOrg({
      name: initialOrganization.name,
      legal_name: initialOrganization.legal_name,
      phone: initialOrganization.phone ?? "",
      timezone: initialOrganization.timezone ?? "America/Chicago",
      currency: initialOrganization.currency ?? "USD",
      address_line1: initialOrganization.address_line1 ?? "",
      city: initialOrganization.city ?? "",
      state: initialOrganization.state ?? "",
      postal_code: initialOrganization.postal_code ?? "",
      country: initialOrganization.country ?? "US",
    });
    setBasis(String(initialAnswers.basis ?? "accrual"));
    setFiscalYearStart(String(initialAnswers.fiscalYearStart ?? "1"));
    setCollectTax(
      initialAnswers.collectTax !== false &&
        initialAnswers.collectTax !== "false" &&
        initialAnswers.collectTax !== "no",
    );
    setTaxRate(String(initialAnswers.taxRate ?? "0"));
  }, [initialOrganization, initialAnswers]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSaved(false);
    setPending(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization: org,
          answers: {
            basis,
            fiscalYearStart,
            collectTax,
            taxRate: collectTax ? Number(taxRate) || 0 : 0,
          },
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not save settings");
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save settings");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-6">
      <section className="card p-5 space-y-4">
        <h2 className="font-ledger text-2xl text-navy">Company</h2>
        <dl className="grid gap-2 text-sm md:grid-cols-2 mb-4">
          <div>
            <dt className="text-muted">Industry</dt>
            <dd>{industryName}</dd>
          </div>
          <div>
            <dt className="text-muted">Source</dt>
            <dd className="capitalize">{initialOrganization.organization_source ?? "direct"}</dd>
          </div>
          <div>
            <dt className="text-muted">Modules</dt>
            <dd>{modules.join(", ") || "—"}</dd>
          </div>
        </dl>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm">
            <span className="text-muted">Display name</span>
            <input
              className="input mt-1 w-full"
              value={org.name}
              onChange={(event) => setOrg({ ...org, name: event.target.value })}
              required
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted">Legal name</span>
            <input
              className="input mt-1 w-full"
              value={org.legal_name}
              onChange={(event) => setOrg({ ...org, legal_name: event.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted">Phone</span>
            <input
              className="input mt-1 w-full"
              value={org.phone}
              onChange={(event) => setOrg({ ...org, phone: event.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted">Currency</span>
            <input
              className="input mt-1 w-full"
              value={org.currency}
              onChange={(event) => setOrg({ ...org, currency: event.target.value.toUpperCase() })}
              maxLength={3}
            />
          </label>
          <label className="block text-sm md:col-span-2">
            <span className="text-muted">Street address</span>
            <input
              className="input mt-1 w-full"
              value={org.address_line1}
              onChange={(event) => setOrg({ ...org, address_line1: event.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted">City</span>
            <input
              className="input mt-1 w-full"
              value={org.city}
              onChange={(event) => setOrg({ ...org, city: event.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted">State</span>
            <input
              className="input mt-1 w-full"
              value={org.state}
              onChange={(event) => setOrg({ ...org, state: event.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted">Postal code</span>
            <input
              className="input mt-1 w-full"
              value={org.postal_code}
              onChange={(event) => setOrg({ ...org, postal_code: event.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted">Country</span>
            <input
              className="input mt-1 w-full"
              value={org.country}
              onChange={(event) => setOrg({ ...org, country: event.target.value.toUpperCase() })}
              maxLength={2}
            />
          </label>
        </div>
      </section>

      <section className="card p-5 space-y-4">
        <h2 className="font-ledger text-2xl text-navy">Accounting</h2>
        <p className="text-sm text-muted">
          These settings drive reports, invoice tax defaults, and how profit &amp; loss is calculated.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm">
            <span className="text-muted">Accounting basis</span>
            <select
              className="input mt-1 w-full"
              value={basis}
              onChange={(event) => setBasis(event.target.value)}
            >
              {ACCOUNTING_BASIS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-muted">Fiscal year starts</span>
            <select
              className="input mt-1 w-full"
              value={fiscalYearStart}
              onChange={(event) => setFiscalYearStart(event.target.value)}
            >
              {FISCAL_MONTHS.map((month) => (
                <option key={month.value} value={month.value}>
                  {month.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm md:col-span-2">
            <input
              type="checkbox"
              checked={collectTax}
              onChange={(event) => setCollectTax(event.target.checked)}
            />
            <span>Collect sales tax on invoices</span>
          </label>
          {collectTax ? (
            <label className="block text-sm">
              <span className="text-muted">Default tax rate (%)</span>
              <input
                className="input mt-1 w-full"
                type="number"
                min="0"
                step="0.01"
                value={taxRate}
                onChange={(event) => setTaxRate(event.target.value)}
              />
            </label>
          ) : null}
        </div>
      </section>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {saved ? <p className="text-sm text-green-700">Settings saved.</p> : null}

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Saving…" : "Save settings"}
      </button>
    </form>
  );
}
