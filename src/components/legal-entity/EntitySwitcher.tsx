"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { routes } from "@/lib/routes";
import type { ActiveLegalEntitySummary } from "@/types";

export function EntitySwitcher({
  activeLegalEntity,
  accessibleEntities,
  showEntitySwitcher,
}: {
  activeLegalEntity: ActiveLegalEntitySummary | null | undefined;
  accessibleEntities: ActiveLegalEntitySummary[] | undefined;
  showEntitySwitcher: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!activeLegalEntity) return null;

  const entityCount = accessibleEntities?.length ?? 0;

  if (!showEntitySwitcher || entityCount <= 1) {
    return (
      <div className="mt-2 space-y-2">
        <p className="text-[11px] text-white/55">
          Books for: {activeLegalEntity.name}
          {activeLegalEntity.entityCode ? ` (${activeLegalEntity.entityCode})` : ""}
        </p>
        {entityCount <= 1 ? (
          <p className="text-[10px] text-white/40">
            Your books are set up for one company.
          </p>
        ) : null}
      </div>
    );
  }

  async function onChange(nextId: string) {
    if (!nextId || nextId === activeLegalEntity?.id) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/legal-entities/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ legalEntityId: nextId }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Could not switch company");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not switch company");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-3 space-y-2">
      <label htmlFor="entity-switcher" className="text-[10px] uppercase tracking-[0.14em] text-white/45">
        Switch company
      </label>
      <select
        id="entity-switcher"
        className="w-full rounded-md border border-white/15 bg-white/10 px-2 py-1.5 text-xs text-white disabled:opacity-60"
        value={activeLegalEntity.id}
        disabled={pending}
        aria-busy={pending}
        onChange={(event) => void onChange(event.target.value)}
      >
        {accessibleEntities?.map((entity) => (
          <option key={entity.id} value={entity.id} className="text-black">
            {entity.name} ({entity.entityCode})
          </option>
        ))}
      </select>
      <div className="space-y-1 border-t border-white/10 pt-2 text-[11px]">
        <Link href={routes.companiesOverview} className="block text-sky-200 hover:underline">
          All Companies overview
        </Link>
        <Link href={routes.reportsConsolidated} className="block text-sky-200 hover:underline">
          Consolidated reports
        </Link>
        <Link href={routes.entitySettings} className="block text-white/55 hover:text-white/80">
          Manage companies
        </Link>
      </div>
      {error ? <p className="text-[11px] text-rose-200">{error}</p> : null}
    </div>
  );
}
