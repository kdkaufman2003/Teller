"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function VendorForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("Net 30");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      const response = await fetch("/api/vendors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, paymentTerms }),
      });
      const payload = (await response.json()) as { error?: string; id?: string };
      if (!response.ok) throw new Error(payload.error || "Could not create vendor");
      router.push(`/app/vendors/${payload.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create vendor");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="card p-4 space-y-3" onSubmit={(event) => void submit(event)}>
      <h2 className="font-medium">New vendor</h2>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1 block text-muted">Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">Email</span>
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">Payment terms</span>
          <input value={paymentTerms} onChange={(event) => setPaymentTerms(event.target.value)} />
        </label>
      </div>
      <button className="btn btn-brass" disabled={pending} type="submit">
        Create vendor
      </button>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </form>
  );
}
