"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function InvoiceActions({
  id,
  status,
}: {
  id: string;
  status: string;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function run(action: "open" | "paid" | "void") {
    setError("");
    setPending(true);
    try {
      const response = await fetch(`/api/invoices/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Update failed");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {status === "draft" ? (
        <button className="btn btn-primary" disabled={pending} onClick={() => void run("open")}>
          Post to ledger
        </button>
      ) : null}
      {status === "draft" || status === "open" ? (
        <button className="btn btn-secondary" disabled={pending} onClick={() => void run("paid")}>
          Mark paid
        </button>
      ) : null}
      {status !== "void" && status !== "paid" ? (
        <button className="btn btn-ghost" disabled={pending} onClick={() => void run("void")}>
          Void
        </button>
      ) : null}
      {error ? <p className="w-full text-sm text-danger">{error}</p> : null}
    </div>
  );
}
