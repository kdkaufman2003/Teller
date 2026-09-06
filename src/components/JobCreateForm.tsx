"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { jobPath } from "@/lib/routes";

export function JobCreateForm({ customers }: { customers: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          customerPartyId: form.get("customerPartyId") || undefined,
          jobType: form.get("jobType") || "Replacement",
          address: form.get("address") || "",
          originalContractAmount: Number(form.get("contract") || 0),
          estimatedRevenue: Number(form.get("contract") || 0),
          estimatedCost: Number(form.get("estimatedCost") || 0),
          estimatedCompletionDate: form.get("estimatedCompletionDate") || undefined,
        }),
      });
      const payload = (await response.json()) as { error?: string; job?: { id: string } };
      if (!response.ok) throw new Error(payload.error || "Could not create job");
      router.push(jobPath(payload.job!.id));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create job");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card grid gap-3 p-5 md:grid-cols-2">
      <input name="name" placeholder="Job name" required />
      <select name="customerPartyId" defaultValue="">
        <option value="">Customer</option>
        {customers.map((customer) => (
          <option key={customer.id} value={customer.id}>
            {customer.name}
          </option>
        ))}
      </select>
      <select name="jobType" defaultValue="Replacement">
        <option>Replacement</option>
        <option>New Construction</option>
        <option>Service</option>
        <option>Commercial</option>
        <option>Maintenance</option>
        <option>Other</option>
      </select>
      <input name="contract" type="number" step="0.01" placeholder="Contract / estimate" />
      <input name="estimatedCost" type="number" step="0.01" placeholder="Estimated cost" />
      <input name="estimatedCompletionDate" type="date" />
      <input className="md:col-span-2" name="address" placeholder="Service address" />
      <button className="btn btn-primary md:col-span-2" disabled={pending} type="submit">
        Create job
      </button>
      {error ? <p className="text-sm text-danger md:col-span-2">{error}</p> : null}
    </form>
  );
}
