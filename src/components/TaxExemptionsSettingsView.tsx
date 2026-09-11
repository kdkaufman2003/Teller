"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate } from "@/lib/format";
import { routes } from "@/lib/routes";

type ExemptionIndexRow = {
  id: string;
  partyId?: string | null;
  certificateNumber?: string | null;
  certificateType?: string | null;
  jurisdictionScope: string[];
  effectiveFrom: string;
  effectiveTo?: string | null;
  lifecycleStatus: string;
  expirationWarning?: string | null;
};

export function TaxExemptionsSettingsView() {
  const [rows, setRows] = useState<ExemptionIndexRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void fetch("/api/tax/exemptions")
      .then((response) => response.json())
      .then((data) => {
        setRows(data.exemptions ?? []);
        setLoading(false);
      });
  }, []);

  const expiringSoon = rows.filter(
    (row) => row.expirationWarning === "expires_within_30_days" || row.expirationWarning === "expires_within_60_days",
  );
  const needsReview = rows.filter((row) => row.lifecycleStatus === "needs_review" || row.lifecycleStatus === "draft");
  const expired = rows.filter((row) => row.lifecycleStatus === "expired" || row.expirationWarning === "expired");

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="page-header">
        <Link href={routes.taxSettings} className="text-sm text-muted">
          ← Tax Setup
        </Link>
        <h1 className="font-ledger text-3xl text-navy">Exemption Certificates</h1>
        <p className="text-muted">Review active, expiring, and needs-review customer exemptions.</p>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="card p-4">
          <p className="text-muted text-sm">Expiring soon</p>
          <p className="font-tabular text-2xl">{expiringSoon.length}</p>
        </div>
        <div className="card p-4">
          <p className="text-muted text-sm">Needs review / draft</p>
          <p className="font-tabular text-2xl">{needsReview.length}</p>
        </div>
        <div className="card p-4">
          <p className="text-muted text-sm">Expired</p>
          <p className="font-tabular text-2xl">{expired.length}</p>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Certificate</th>
              <th>Jurisdiction</th>
              <th>Effective</th>
              <th>Expires</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="text-muted">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-muted">
                  No exemption certificates configured
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.certificateType || "other"}</td>
                  <td>{row.certificateNumber || "—"}</td>
                  <td>{row.jurisdictionScope.join(", ")}</td>
                  <td>{formatDate(row.effectiveFrom)}</td>
                  <td>{row.effectiveTo ? formatDate(row.effectiveTo) : "—"}</td>
                  <td>
                    <StatusBadge status={row.lifecycleStatus} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
