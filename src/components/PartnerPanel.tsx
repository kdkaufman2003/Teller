"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { QuoterSyncButton } from "@/components/QuoterSyncButton";

type PartnerState = {
  mode: "standalone" | "attached";
  partnerId: string | null;
  partner: { name: string; shortName: string; description: string; quoterLabel: string } | null;
  quoterUrl: string | null;
  sharedSupabase: boolean;
  organizationId: string;
  quoter: {
    enabled?: boolean;
    last_synced_at?: string | null;
    last_sync_summary?: unknown;
  } | null;
};

export function PartnerPanel() {
  const router = useRouter();
  const [state, setState] = useState<PartnerState | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function load() {
    const response = await fetch("/api/integrations/partner");
    const payload = (await response.json()) as PartnerState & { error?: string };
    if (!response.ok) throw new Error(payload.error || "Could not load integration settings");
    setState(payload);
  }

  useEffect(() => {
    load().catch((err) =>
      setError(err instanceof Error ? err.message : "Could not load integration settings"),
    );
  }, []);

  async function run(action: "attach" | "detach") {
    setError("");
    setPending(true);
    try {
      const response = await fetch("/api/integrations/partner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          partnerId: action === "attach" ? "hasslefreeac" : undefined,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Update failed");
      await load();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setPending(false);
    }
  }

  if (!state) {
    return <p className="text-sm text-muted">Loading integrations…</p>;
  }

  const attached = state.mode === "attached";
  const integrationName = state.partner?.name ?? "Quote-to-invoice sync";

  return (
    <section className="card space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-ledger text-2xl text-navy">Integrations</h2>
          <p className="mt-1 text-sm text-muted">
            Teller is always your system of record. Connect a quoting platform to
            import customers and won deals — disconnect anytime and keep your books.
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            attached ? "bg-brass/20 text-brass-deep" : "bg-rule/60 text-muted"
          }`}
        >
          {attached ? `Connected · ${state.partner?.shortName ?? "Integration"}` : "Not connected"}
        </span>
      </div>

      {attached ? (
        <div className="space-y-3 text-sm">
          <p>
            <strong>{integrationName}</strong> is active. Imported customers and
            draft invoices stay in Teller; you control posting and payment.
          </p>
          {state.quoterUrl ? (
            <a
              href={state.quoterUrl}
              target="_blank"
              rel="noreferrer"
              className="btn btn-ghost inline-flex text-sm"
            >
              Open {state.partner?.quoterLabel ?? "connected app"}
            </a>
          ) : null}
          {!state.sharedSupabase ? (
            <p className="text-warn">
              Database sync is off. Use the webhook from your quoting tool or point
              both apps at the same database project.
            </p>
          ) : null}
          {state.quoter?.last_synced_at ? (
            <p className="text-muted">
              Last sync {new Date(state.quoter.last_synced_at).toLocaleString()}
            </p>
          ) : null}
          <QuoterSyncButton />
          <button
            type="button"
            className="btn btn-ghost text-sm"
            disabled={pending}
            onClick={() => void run("detach")}
          >
            Disconnect integration
          </button>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p>
            No integrations connected. You can use every Teller feature manually, or
            connect a quoting platform to import customers and won quotes.
          </p>
          <button
            type="button"
            className="btn btn-brass text-sm"
            disabled={pending}
            onClick={() => void run("attach")}
          >
            Connect quote-to-invoice sync
          </button>
        </div>
      )}

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <details className="text-xs text-muted">
        <summary className="cursor-pointer">Webhook organization id</summary>
        <p className="mt-2 font-tabular">{state.organizationId}</p>
      </details>
    </section>
  );
}
