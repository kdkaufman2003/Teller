"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { todayISO } from "@/lib/format";

type Vendor = { id: string; name: string };
type OpenBill = { id: string; number: string; remaining: number; due_date?: string };
type VendorCredit = { id: string; number: string; unapplied: number };

export function MultiBillPayForm({
  vendors,
  initialVendorId,
}: {
  vendors: Vendor[];
  initialVendorId?: string;
}) {
  const router = useRouter();
  const [partyId, setPartyId] = useState(initialVendorId || vendors[0]?.id || "");
  const [bills, setBills] = useState<OpenBill[]>([]);
  const [credits, setCredits] = useState<VendorCredit[]>([]);
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [creditApps, setCreditApps] = useState<Record<string, string>>({});
  const [paymentDate, setPaymentDate] = useState(todayISO());
  const [referenceNumber, setReferenceNumber] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [memo, setMemo] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const cashTotal = useMemo(
    () =>
      Object.entries(allocations).reduce((sum, [, value]) => sum + (Number(value) || 0), 0),
    [allocations],
  );

  async function loadVendorData(vendorId: string) {
    setLoaded(false);
    const response = await fetch(`/api/vendors/${vendorId}`);
    const payload = (await response.json()) as {
      openBills?: Array<{ id: string; number: string; remaining: number; due_date?: string }>;
      vendorCredits?: Array<{ id: string; number: string; total: number }>;
      unappliedCredits?: number;
    };
    if (!response.ok) return;
    setBills(
      (payload.openBills ?? []).map((row) => ({
        id: row.id,
        number: row.number,
        remaining: row.remaining,
        due_date: row.due_date,
      })),
    );
    setCredits(
      await Promise.all(
        (payload.vendorCredits ?? []).map(async (credit) => {
          const detail = await fetch(`/api/vendor-credits/${credit.id}`).then((r) => r.json());
          return {
            id: credit.id,
            number: credit.number,
            unapplied: detail.vendorCredit?.unapplied_balance ?? 0,
          };
        }),
      ),
    );
    setAllocations({});
    setCreditApps({});
    setLoaded(true);
  }

  async function onVendorChange(vendorId: string) {
    setPartyId(vendorId);
    await loadVendorData(vendorId);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      const billAllocations = Object.entries(allocations)
        .map(([documentId, amount]) => ({ documentId, amount: Number(amount) }))
        .filter((row) => row.amount > 0);
      if (!billAllocations.length) throw new Error("Enter at least one bill allocation");

      const creditApplications = Object.entries(creditApps)
        .map(([sourceDocumentId, amount]) => {
          const target = billAllocations[0]?.documentId;
          return target
            ? { sourceDocumentId, targetDocumentId: target, amount: Number(amount) }
            : null;
        })
        .filter(Boolean) as Array<{
        sourceDocumentId: string;
        targetDocumentId: string;
        amount: number;
      }>;

      const response = await fetch("/api/bills/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partyId,
          paymentDate,
          referenceNumber,
          paymentMethod,
          memo,
          allocations: billAllocations,
          creditApplications: creditApplications.filter((row) => row.amount > 0),
          idempotencyKey: `${partyId}:${paymentDate}:${referenceNumber}:${cashTotal.toFixed(2)}`,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Payment failed");
      router.push("/app/bills");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-6" onSubmit={(event) => void submit(event)}>
      <div className="card p-4 grid gap-3 md:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-muted">Vendor</span>
          <select
            value={partyId}
            onChange={(event) => void onVendorChange(event.target.value)}
            required
          >
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.name}
              </option>
            ))}
          </select>
        </label>
        {!loaded && partyId ? (
          <div className="flex items-end">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void loadVendorData(partyId)}
            >
              Load open bills
            </button>
          </div>
        ) : null}
      </div>

      {loaded ? (
        <>
          <section className="card p-4 space-y-3">
            <h2 className="font-medium">Open bills</h2>
            {bills.length === 0 ? (
              <p className="text-muted text-sm">No open bills for this vendor.</p>
            ) : (
              <table className="data-table text-sm">
                <thead>
                  <tr>
                    <th>Bill</th>
                    <th>Due</th>
                    <th className="text-right">Remaining</th>
                    <th className="text-right">Pay amount</th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((bill) => (
                    <tr key={bill.id}>
                      <td>{bill.number}</td>
                      <td>{bill.due_date || "—"}</td>
                      <td className="text-right font-tabular">${bill.remaining.toFixed(2)}</td>
                      <td className="text-right">
                        <input
                          type="number"
                          min="0"
                          max={bill.remaining}
                          step="0.01"
                          value={allocations[bill.id] || ""}
                          onChange={(event) =>
                            setAllocations((current) => ({
                              ...current,
                              [bill.id]: event.target.value,
                            }))
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {credits.some((row) => row.unapplied > 0.009) ? (
            <section className="card p-4 space-y-3">
              <h2 className="font-medium">Apply vendor credits (optional)</h2>
              <table className="data-table text-sm">
                <thead>
                  <tr>
                    <th>Credit</th>
                    <th className="text-right">Available</th>
                    <th className="text-right">Apply</th>
                  </tr>
                </thead>
                <tbody>
                  {credits
                    .filter((row) => row.unapplied > 0.009)
                    .map((credit) => (
                      <tr key={credit.id}>
                        <td>{credit.number}</td>
                        <td className="text-right font-tabular">${credit.unapplied.toFixed(2)}</td>
                        <td className="text-right">
                          <input
                            type="number"
                            min="0"
                            max={credit.unapplied}
                            step="0.01"
                            value={creditApps[credit.id] || ""}
                            onChange={(event) =>
                              setCreditApps((current) => ({
                                ...current,
                                [credit.id]: event.target.value,
                              }))
                            }
                          />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </section>
          ) : null}

          <section className="card p-4 grid gap-3 md:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-muted">Payment date</span>
              <input type="date" value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted">Reference #</span>
              <input value={referenceNumber} onChange={(event) => setReferenceNumber(event.target.value)} />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted">Method</span>
              <input value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted">Memo</span>
              <input value={memo} onChange={(event) => setMemo(event.target.value)} />
            </label>
          </section>

          <div className="flex flex-wrap items-center gap-4">
            <p className="text-sm">
              Cash payment total: <strong className="font-tabular">${cashTotal.toFixed(2)}</strong>
            </p>
            <button className="btn btn-brass" disabled={pending || cashTotal <= 0} type="submit">
              Record payment
            </button>
          </div>
        </>
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </form>
  );
}
