"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
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

  if (!activeLegalEntity || !showEntitySwitcher || (accessibleEntities?.length ?? 0) <= 1) {
    if (activeLegalEntity) {
      return (
        <p className="mt-2 text-[11px] text-white/55">
          Books for: {activeLegalEntity.name}
          {activeLegalEntity.entityCode ? ` (${activeLegalEntity.entityCode})` : ""}
        </p>
      );
    }
    return null;
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
    <div className="mt-3 space-y-1">
      <label htmlFor="entity-switcher" className="text-[10px] uppercase tracking-[0.14em] text-white/45">
        Active company
      </label>
      <select
        id="entity-switcher"
        className="w-full rounded-md border border-white/15 bg-white/10 px-2 py-1.5 text-xs text-white"
        value={activeLegalEntity.id}
        disabled={pending}
        onChange={(event) => void onChange(event.target.value)}
      >
        {accessibleEntities?.map((entity) => (
          <option key={entity.id} value={entity.id} className="text-black">
            {entity.name} ({entity.entityCode})
          </option>
        ))}
      </select>
      {error ? <p className="text-[11px] text-rose-200">{error}</p> : null}
    </div>
  );
}
