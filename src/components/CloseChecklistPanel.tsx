"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type CloseChecklistItem = {
  id: string;
  item_key: string;
  title: string;
  description: string;
  required: boolean;
  status: string;
  source: string;
  sort_order: number;
};

export function CloseChecklistPanel({
  periodEnd,
  items,
  canManage,
}: {
  periodEnd: string;
  items: CloseChecklistItem[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggleItem(item: CloseChecklistItem) {
    if (!canManage) return;
    setBusyKey(item.item_key);
    setError(null);
    const complete = item.status !== "completed";
    const response = await fetch("/api/accounting/close/checklist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        periodEnd,
        itemKey: item.item_key,
        title: item.title,
        description: item.description,
        required: item.required,
        complete,
      }),
    });
    setBusyKey(null);
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setError(payload.error ?? "Could not update checklist item");
      return;
    }
    router.refresh();
  }

  return (
    <div className="card overflow-hidden">
      <div className="border-b px-4 py-3">
        <h2 className="font-medium">Close checklist</h2>
        <p className="text-sm text-muted">
          Review tasks for this period. Required incomplete items block close.
        </p>
      </div>
      {error ? <p className="px-4 py-2 text-sm text-red-700">{error}</p> : null}
      {!items.length ? (
        <p className="px-4 py-6 text-sm text-muted">
          No checklist items yet. System items appear when close review runs.
        </p>
      ) : (
        <ul className="divide-y">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-3 px-4 py-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={item.status === "completed"}
                disabled={!canManage || busyKey === item.item_key}
                onChange={() => toggleItem(item)}
              />
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {item.title}
                  {item.required ? (
                    <span className="ml-2 text-xs uppercase tracking-wide text-amber-800">
                      Required
                    </span>
                  ) : null}
                </p>
                {item.description ? (
                  <p className="mt-1 text-sm text-muted">{item.description}</p>
                ) : null}
                <p className="mt-1 text-xs capitalize text-muted">
                  {item.status.replace(/_/g, " ")} · {item.source}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
