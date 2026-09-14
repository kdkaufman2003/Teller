"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Vendor = { id: string; name: string };

export function DocumentVendorSelect({
  actionUrl,
  currentPartyId,
  currentName,
  vendors,
  disabled = false,
  disabledReason,
}: {
  actionUrl: string;
  currentPartyId: string | null;
  currentName: string;
  vendors: Vendor[];
  disabled?: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const [partyId, setPartyId] = useState(currentPartyId || "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  if (disabled) {
    return (
      <div>
        <p>{currentName}</p>
        {disabledReason ? <p className="mt-1 text-xs text-muted">{disabledReason}</p> : null}
      </div>
    );
  }

  async function changeVendor(nextPartyId: string) {
    if (!nextPartyId || nextPartyId === currentPartyId) {
      setPartyId(currentPartyId || "");
      return;
    }
    setError("");
    setPending(true);
    setPartyId(nextPartyId);
    try {
      const response = await fetch(actionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "change_vendor", partyId: nextPartyId }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not change vendor");
      router.refresh();
    } catch (err) {
      setPartyId(currentPartyId || "");
      setError(err instanceof Error ? err.message : "Could not change vendor");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-1">
      <select
        aria-label="Vendor"
        value={partyId}
        disabled={pending}
        onChange={(event) => void changeVendor(event.target.value)}
      >
        {!currentPartyId ? <option value="">Select vendor…</option> : null}
        {vendors.map((vendor) => (
          <option key={vendor.id} value={vendor.id}>
            {vendor.name}
          </option>
        ))}
      </select>
      {pending ? <p className="text-xs text-muted">Saving…</p> : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}

export function BillVendorSelect(
  props: Omit<Parameters<typeof DocumentVendorSelect>[0], "actionUrl"> & { billId: string },
) {
  const { billId, ...rest } = props;
  return <DocumentVendorSelect {...rest} actionUrl={`/api/bills/${billId}`} />;
}
