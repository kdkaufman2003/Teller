"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type PartnerState = {
  mode: "standalone" | "attached";
  partnerId: string | null;
  partner: {
    name: string;
    shortName: string;
    description: string;
    platformLabel: string;
  } | null;
  platformUrl: string | null;
  webhookUrl: string | null;
  webhookUrls: {
    quotes: string | null;
    subscribers: string | null;
    payments: string | null;
  };
  organizationId: string;
  hfac: {
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
  const integrationName = state.partner?.name ?? "Hassle Free AC";

  return (
    <section className="card space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-ledger text-2xl text-navy">Integrations</h2>
          <p className="mt-1 text-sm text-muted">
            Teller works fully on its own — customers, invoices, and ledger without
            any integration. Optional: connect Hassle Free AC to import subscribers,
            won deals, and Stripe payments over secure webhooks.
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            attached ? "bg-brass/20 text-brass-deep" : "bg-rule/60 text-muted"
          }`}
        >
          {attached ? `Connected · ${state.partner?.shortName ?? "HFAC"}` : "Not connected"}
        </span>
      </div>

      {attached ? (
        <div className="space-y-3 text-sm">
          <p>
            <strong>{integrationName}</strong> is connected. Imports are optional
            shortcuts — you can still enter everything manually in Teller.
          </p>
          {state.platformUrl ? (
            <a
              href={state.platformUrl}
              target="_blank"
              rel="noreferrer"
              className="btn btn-ghost inline-flex text-sm"
            >
              Open {state.partner?.platformLabel ?? "Hassle Free AC"}
            </a>
          ) : null}
          {state.hfac?.last_synced_at ? (
            <p className="text-muted">
              Last webhook {new Date(state.hfac.last_synced_at).toLocaleString()}
            </p>
          ) : (
            <p className="text-muted">No imports yet — manual entry works anytime.</p>
          )}
          <div className="rounded-lg border border-rule bg-paper p-3 text-xs">
            <p className="font-medium text-navy">Hassle Free AC env (optional)</p>
            <ul className="mt-2 space-y-1 font-tabular text-muted">
              <li>TELLER_WEBHOOK_SECRET=&lt;shared secret&gt;</li>
              <li>TELLER_ORGANIZATION_ID={state.organizationId}</li>
              <li>TELLER_SUBSCRIBERS_URL={state.webhookUrls?.subscribers ?? "<teller-url>/api/integrations/hfac/subscribers"}</li>
              <li>TELLER_QUOTES_URL={state.webhookUrls?.quotes ?? state.webhookUrl ?? "<teller-url>/api/integrations/hfac/quotes"}</li>
              <li>TELLER_PAYMENTS_URL={state.webhookUrls?.payments ?? "<teller-url>/api/integrations/hfac/payments"}</li>
            </ul>
          </div>
          <button
            type="button"
            className="btn btn-ghost text-sm"
            disabled={pending}
            onClick={() => void run("detach")}
          >
            Disconnect Hassle Free AC
          </button>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p>
            Optional: connect Hassle Free AC to import subscribers, won deals, and
            Stripe payment confirmations. Teller remains fully usable without this.
          </p>
          <button
            type="button"
            className="btn btn-brass text-sm"
            disabled={pending}
            onClick={() => void run("attach")}
          >
            Connect Hassle Free AC
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
