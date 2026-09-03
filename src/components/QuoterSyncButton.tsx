"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function QuoterSyncButton() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<string>("");
  const [pending, setPending] = useState(false);

  async function sync() {
    setError("");
    setSummary("");
    setPending(true);
    try {
      const response = await fetch("/api/integrations/quoter/sync", {
        method: "POST",
      });
      const payload = (await response.json()) as {
        error?: string;
        summary?: unknown;
      };
      if (!response.ok) throw new Error(payload.error || "Sync failed");
      setSummary(JSON.stringify(payload.summary, null, 2));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button type="button" className="btn btn-brass" disabled={pending} onClick={() => void sync()}>
        {pending ? "Syncing…" : "Sync dealers & won quotes"}
      </button>
      {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      {summary ? (
        <pre className="mt-3 overflow-auto rounded-lg bg-paper p-3 text-xs">{summary}</pre>
      ) : null}
    </div>
  );
}
