"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function JobForm({
  customers,
}: {
  customers: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [partyId, setPartyId] = useState("");
  const [jobType, setJobType] = useState("install");
  const [quotedAmount, setQuotedAmount] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          partyId,
          jobType,
          quotedAmount: Number(quotedAmount || 0),
          address,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not save");
      setName("");
      setQuotedAmount("");
      setAddress("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card grid gap-3 p-4 md:grid-cols-5">
      <input
        placeholder="Job name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />
      <select value={partyId} onChange={(event) => setPartyId(event.target.value)}>
        <option value="">Customer</option>
        {customers.map((customer) => (
          <option key={customer.id} value={customer.id}>
            {customer.name}
          </option>
        ))}
      </select>
      <select value={jobType} onChange={(event) => setJobType(event.target.value)}>
        <option value="install">Install</option>
        <option value="service">Service</option>
        <option value="maintenance">Maintenance</option>
        <option value="warranty">Warranty</option>
        <option value="other">Other</option>
      </select>
      <input
        placeholder="Quoted amount"
        value={quotedAmount}
        onChange={(event) => setQuotedAmount(event.target.value)}
      />
      <button className="btn btn-primary" disabled={pending} type="submit">
        Add job
      </button>
      <input
        className="md:col-span-5"
        placeholder="Job site address"
        value={address}
        onChange={(event) => setAddress(event.target.value)}
      />
      {error ? <p className="text-sm text-danger md:col-span-5">{error}</p> : null}
    </form>
  );
}
