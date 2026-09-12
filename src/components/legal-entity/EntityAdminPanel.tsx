"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { LegalEntitySummary } from "@/lib/accounting/legal-entity/types";
import type { ProfileRole } from "@/types";

type OrgMember = {
  id: string;
  full_name: string;
  email: string;
  role: ProfileRole;
};

export function EntityAdminPanel({
  initialEntities,
  members,
  canManageAccess,
}: {
  initialEntities: LegalEntitySummary[];
  members: OrgMember[];
  canManageAccess: boolean;
}) {
  const router = useRouter();
  const [entities, setEntities] = useState(initialEntities);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: "",
    legalName: "",
    entityCode: "",
    countryCode: "US",
    stateCode: "",
    baseCurrency: "USD",
  });
  const [accessProfileId, setAccessProfileId] = useState(members[0]?.id ?? "");
  const [accessEntityId, setAccessEntityId] = useState(initialEntities[0]?.id ?? "");

  const activeEntities = useMemo(
    () => entities.filter((entity) => entity.isActive),
    [entities],
  );

  async function refreshEntities() {
    const response = await fetch("/api/legal-entities?admin=true&includeInactive=true");
    const payload = (await response.json()) as { entities?: LegalEntitySummary[]; error?: string };
    if (!response.ok) throw new Error(payload.error || "Could not load companies");
    setEntities(payload.entities ?? []);
  }

  async function createEntity(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/legal-entities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not create company");
      setForm({
        name: "",
        legalName: "",
        entityCode: "",
        countryCode: "US",
        stateCode: "",
        baseCurrency: "USD",
      });
      setMessage("Company created");
      await refreshEntities();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create company");
    } finally {
      setCreating(false);
    }
  }

  async function archiveEntity(entityId: string) {
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/legal-entities/${entityId}/archive`, { method: "POST" });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not archive company");
      setMessage("Company archived");
      await refreshEntities();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not archive company");
    }
  }

  async function setDefault(entityId: string) {
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/legal-entities/${entityId}/default`, { method: "POST" });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not change default company");
      setMessage("Default company updated");
      await refreshEntities();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change default company");
    }
  }

  async function grantAccess() {
    if (!accessProfileId || !accessEntityId) return;
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/legal-entities/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: accessProfileId, legalEntityId: accessEntityId }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not grant access");
      setMessage("Company access granted");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not grant access");
    }
  }

  async function revokeAccess(profileId: string, legalEntityId: string) {
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/legal-entities/access?profileId=${encodeURIComponent(profileId)}&legalEntityId=${encodeURIComponent(legalEntityId)}`,
        { method: "DELETE" },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not revoke access");
      setMessage("Company access revoked");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke access");
    }
  }

  return (
    <div className="space-y-6">
      {message ? <p className="text-sm text-emerald-700">{message}</p> : null}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      <section className="card p-4">
        <h2 className="font-medium">Companies</h2>
        <p className="text-muted mb-4 text-sm">
          Each company represents a separate set of books within your organization.
        </p>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Code</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Default</th>
                <th className="py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {entities.map((entity) => (
                <tr key={entity.id} className="border-b">
                  <td className="py-2 pr-4">{entity.name}</td>
                  <td className="py-2 pr-4">{entity.entityCode}</td>
                  <td className="py-2 pr-4">{entity.isActive ? "Active" : "Archived"}</td>
                  <td className="py-2 pr-4">{entity.isDefault ? "Yes" : "No"}</td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-2">
                      {!entity.isDefault && entity.isActive ? (
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void setDefault(entity.id)}>
                          Set default
                        </button>
                      ) : null}
                      {entity.isActive && !entity.isDefault ? (
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void archiveEntity(entity.id)}>
                          Archive
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card p-4">
        <h2 className="font-medium">Add company</h2>
        <p className="mt-2 text-sm text-muted">
          After creating a company, complete setup: chart of accounts, fiscal settings, tax
          settings, opening balances (if needed), bank accounts, user access, and period readiness.
          Copying a chart of accounts from another company copies structure only — never balances or
          history.
        </p>
        <form className="mt-4 grid gap-3 md:grid-cols-2" onSubmit={(event) => void createEntity(event)}>
          <label className="block text-sm">
            Name
            <input
              className="input mt-1 w-full"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              required
            />
          </label>
          <label className="block text-sm">
            Legal name
            <input
              className="input mt-1 w-full"
              value={form.legalName}
              onChange={(event) => setForm((current) => ({ ...current, legalName: event.target.value }))}
            />
          </label>
          <label className="block text-sm">
            Code
            <input
              className="input mt-1 w-full"
              value={form.entityCode}
              onChange={(event) => setForm((current) => ({ ...current, entityCode: event.target.value }))}
              required
            />
          </label>
          <label className="block text-sm">
            Base currency
            <input
              className="input mt-1 w-full"
              value={form.baseCurrency}
              onChange={(event) => setForm((current) => ({ ...current, baseCurrency: event.target.value }))}
            />
          </label>
          <label className="block text-sm">
            Country
            <input
              className="input mt-1 w-full"
              value={form.countryCode}
              onChange={(event) => setForm((current) => ({ ...current, countryCode: event.target.value }))}
            />
          </label>
          <label className="block text-sm">
            State
            <input
              className="input mt-1 w-full"
              value={form.stateCode}
              onChange={(event) => setForm((current) => ({ ...current, stateCode: event.target.value }))}
            />
          </label>
          <div className="md:col-span-2">
            <button type="submit" className="btn btn-primary" disabled={creating}>
              {creating ? "Creating…" : "Create company"}
            </button>
          </div>
        </form>
      </section>

      {canManageAccess ? (
        <section className="card p-4">
          <h2 className="font-medium">Company access</h2>
          <p className="text-muted mb-4 text-sm">
            Owners and admins can access all companies automatically. Grant access here to restrict a
            member to specific companies.
          </p>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="block text-sm">
              Member
              <select
                className="input mt-1 w-full"
                value={accessProfileId}
                onChange={(event) => setAccessProfileId(event.target.value)}
              >
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.full_name || member.email} ({member.role})
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              Company
              <select
                className="input mt-1 w-full"
                value={accessEntityId}
                onChange={(event) => setAccessEntityId(event.target.value)}
              >
                {activeEntities.map((entity) => (
                  <option key={entity.id} value={entity.id}>
                    {entity.name} ({entity.entityCode})
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end">
              <button type="button" className="btn btn-secondary" onClick={() => void grantAccess()}>
                Grant access
              </button>
            </div>
          </div>
          {accessProfileId && activeEntities[0] ? (
            <div className="mt-4">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void revokeAccess(accessProfileId, accessEntityId)}
              >
                Revoke selected access
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
