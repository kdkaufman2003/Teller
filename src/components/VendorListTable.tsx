"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { money } from "@/lib/format";
import { routes, vendorPath } from "@/lib/routes";

export type VendorRow = {
  id: string;
  name: string;
  email: string;
  party_status: string;
  payment_terms: string;
  openBalance: number;
  overdueBalance: number;
  availableCredits: number;
  recentActivity: string;
};

export function VendorListTable({ vendors }: { vendors: VendorRow[] }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");

  const filtered = useMemo(() => {
    return vendors.filter((row) => {
      if (statusFilter === "active" && row.party_status !== "active") return false;
      if (statusFilter === "inactive" && row.party_status !== "inactive") return false;
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (
        row.name.toLowerCase().includes(q) ||
        row.email.toLowerCase().includes(q) ||
        row.payment_terms.toLowerCase().includes(q)
      );
    });
  }, [vendors, search, statusFilter]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <input
          className="max-w-xs"
          placeholder="Search vendors…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>
      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Vendor</th>
              <th>Status</th>
              <th className="text-right">Open balance</th>
              <th className="text-right">Overdue</th>
              <th className="text-right">Credits</th>
              <th>Recent activity</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-muted">
                  No vendors match your filters.
                </td>
              </tr>
            ) : (
              filtered.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={vendorPath(row.id)} className="font-medium hover:underline">
                      {row.name}
                    </Link>
                    {row.email ? <p className="text-xs text-muted">{row.email}</p> : null}
                  </td>
                  <td className="capitalize">{row.party_status}</td>
                  <td className="text-right font-tabular">{money(row.openBalance)}</td>
                  <td className="text-right font-tabular text-danger">
                    {row.overdueBalance > 0.009 ? money(row.overdueBalance) : "—"}
                  </td>
                  <td className="text-right font-tabular">
                    {row.availableCredits > 0.009 ? money(row.availableCredits) : "—"}
                  </td>
                  <td className="text-muted text-sm">{row.recentActivity || "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-sm">
        <Link href={routes.purchaseOrders} className="text-muted hover:underline">
          Purchase orders →
        </Link>
        {" · "}
        <Link href={routes.billPay} className="text-muted hover:underline">
          Pay bills →
        </Link>
      </p>
    </div>
  );
}
