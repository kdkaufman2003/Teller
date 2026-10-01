"use client";

import { useEffect, useMemo, useState } from "react";
import { industryPacks } from "@/lib/industries/registry";
import type { ProfileRole } from "@/types";

type OrgRow = {
  id: string;
  name: string;
  industry_id: string;
};

type CreateResult = {
  userId: string;
  email: string;
  organizationId: string;
  temporaryPassword: string;
  emailDelivery: string;
};

const ROLES: ProfileRole[] = ["owner", "admin", "bookkeeper", "viewer"];

export function CreatePlatformUserForm() {
  const [mode, setMode] = useState<"existing_org" | "new_org">("new_org");
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [role, setRole] = useState<ProfileRole>("owner");
  const [companyName, setCompanyName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [industryId, setIndustryId] = useState(industryPacks[0]?.id ?? "general");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CreateResult | null>(null);

  const industryOptions = useMemo(
    () => industryPacks.map((pack) => ({ id: pack.id, name: pack.name })),
    [],
  );

  useEffect(() => {
    fetch("/api/platform/organizations")
      .then((res) => res.json())
      .then((data) => {
        const list = (data.organizations ?? []) as OrgRow[];
        setOrgs(list);
        if (list[0]?.id) setOrganizationId(list[0].id);
      })
      .catch(() => undefined);
  }, []);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setResult(null);
    setPending(true);
    try {
      const payload =
        mode === "existing_org"
          ? { mode, email, fullName, organizationId, role }
          : { mode, email, fullName, companyName, legalName, industryId };

      const res = await fetch("/api/platform/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Create failed");
        return;
      }
      setResult(data as CreateResult);
    } catch {
      setError("Network error");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        <button
          type="button"
          className={`btn ${mode === "new_org" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setMode("new_org")}
        >
          New customer org
        </button>
        <button
          type="button"
          className={`btn ${mode === "existing_org" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setMode("existing_org")}
        >
          Add to existing org
        </button>
      </div>

      <form onSubmit={onSubmit} className="card space-y-4 p-4">
        <label className="block space-y-1">
          <span className="text-sm font-medium">Email</span>
          <input
            className="input w-full"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium">Full name</span>
          <input
            className="input w-full"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            autoComplete="off"
          />
        </label>

        {mode === "existing_org" ? (
          <>
            <label className="block space-y-1">
              <span className="text-sm font-medium">Organization</span>
              <select
                className="input w-full"
                value={organizationId}
                onChange={(e) => setOrganizationId(e.target.value)}
                required
              >
                {orgs.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">Role</span>
              <select
                className="input w-full"
                value={role}
                onChange={(e) => setRole(e.target.value as ProfileRole)}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <>
            <label className="block space-y-1">
              <span className="text-sm font-medium">Company name</span>
              <input
                className="input w-full"
                required
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">Legal name (optional)</span>
              <input
                className="input w-full"
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">Industry</span>
              <select
                className="input w-full"
                value={industryId}
                onChange={(e) => setIndustryId(e.target.value)}
              >
                {industryOptions.map((pack) => (
                  <option key={pack.id} value={pack.id}>
                    {pack.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {error ? <p className="text-sm text-red-700">{error}</p> : null}

        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Creating…" : "Create user"}
        </button>
      </form>

      {result ? (
        <section className="card space-y-2 border-amber-200 bg-amber-50 p-4">
          <h2 className="font-medium">Credentials — copy now</h2>
          <p className="text-muted text-sm">
            This temporary password is shown once. A sign-in / password-reset email was also sent when
            delivery succeeded.
          </p>
          <p className="text-sm">
            <span className="font-medium">Email:</span> {result.email}
          </p>
          <p className="font-mono text-sm">{result.temporaryPassword}</p>
          <p className="text-muted text-xs">Email delivery: {result.emailDelivery}</p>
        </section>
      ) : null}
    </div>
  );
}
