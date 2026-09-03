"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function CustomerForm({ singular }: { singular: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      const response = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, phone }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not save");
      setName("");
      setEmail("");
      setPhone("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card grid gap-3 p-4 md:grid-cols-4">
      <input
        placeholder={`${singular} name`}
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />
      <input
        placeholder="Email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <input
        placeholder="Phone"
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
      />
      <button className="btn btn-primary" disabled={pending} type="submit">
        Add {singular.toLowerCase()}
      </button>
      {error ? <p className="text-sm text-danger md:col-span-4">{error}</p> : null}
    </form>
  );
}
