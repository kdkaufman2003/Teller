"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { todayISO } from "@/lib/format";
import { billPath } from "@/lib/routes";

type PoLine = {
  id: string;
  description: string;
  quantity: number;
  quantity_received: number;
  quantity_billed: number;
  unit_cost: number;
};

export function PurchaseOrderActions({
  id,
  status,
  lines,
}: {
  id: string;
  status: string;
  lines: PoLine[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [showReceive, setShowReceive] = useState(false);
  const [showBill, setShowBill] = useState(false);
  const [receiptDate, setReceiptDate] = useState(todayISO());
  const [referenceNumber, setReferenceNumber] = useState("");
  const [location, setLocation] = useState("");
  const [receiveQty, setReceiveQty] = useState<Record<string, string>>({});
  const [billQty, setBillQty] = useState<Record<string, string>>({});
  const [issueDate, setIssueDate] = useState(todayISO());

  async function action(name: string, extra?: Record<string, unknown>) {
    setError("");
    setPending(true);
    try {
      const response = await fetch(`/api/purchase-orders/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: name, ...extra }),
      });
      const payload = (await response.json()) as { error?: string; billId?: string };
      if (!response.ok) throw new Error(payload.error || "Action failed");
      if (payload.billId) router.push(billPath(payload.billId));
      else router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setPending(false);
    }
  }

  async function receive() {
    const receiptLines = lines
      .map((line) => ({
        purchaseOrderLineId: line.id,
        quantityReceived: Number(receiveQty[line.id] || 0),
      }))
      .filter((row) => row.quantityReceived > 0);
    await action("receive", {
      receiptDate,
      referenceNumber,
      location,
      lines: receiptLines,
    });
    setShowReceive(false);
  }

  async function convertToBill() {
    const billLines = lines
      .map((line) => ({
        purchaseOrderLineId: line.id,
        quantityToBill: Number(billQty[line.id] || 0),
      }))
      .filter((row) => row.quantityToBill > 0);
    await action("convert_to_bill", { issueDate, billLines });
    setShowBill(false);
  }

  const canReceive = !["draft", "pending_approval", "cancelled", "closed"].includes(status);
  const canBill = ["partially_received", "received", "partially_billed", "sent", "approved"].includes(
    status,
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {status === "draft" ? (
          <button className="btn btn-brass" disabled={pending} onClick={() => void action("submit")}>
            Submit for approval
          </button>
        ) : null}
        {status === "pending_approval" ? (
          <>
            <button className="btn btn-brass" disabled={pending} onClick={() => void action("approve")}>
              Approve
            </button>
            <button
              className="btn btn-ghost"
              disabled={pending}
              onClick={() => {
                const reason = rejectReason.trim() || prompt("Rejection reason?") || "";
                if (reason) void action("reject", { reason });
              }}
            >
              Reject
            </button>
            <input
              className="max-w-xs"
              placeholder="Rejection reason"
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
            />
          </>
        ) : null}
        {status === "approved" ? (
          <button className="btn btn-brass" disabled={pending} onClick={() => void action("send")}>
            Mark sent
          </button>
        ) : null}
        {canReceive ? (
          <button className="btn btn-brass" disabled={pending} onClick={() => setShowReceive(true)}>
            Receive items
          </button>
        ) : null}
        {canBill ? (
          <button className="btn btn-ghost" disabled={pending} onClick={() => setShowBill(true)}>
            Create bill from PO
          </button>
        ) : null}
        {!["closed", "cancelled"].includes(status) ? (
          <button className="btn btn-ghost" disabled={pending} onClick={() => void action("close")}>
            Close PO
          </button>
        ) : null}
        {!["closed", "cancelled"].includes(status) ? (
          <button className="btn btn-ghost" disabled={pending} onClick={() => void action("cancel")}>
            Cancel
          </button>
        ) : null}
      </div>

      {showReceive ? (
        <div className="card p-4 space-y-3">
          <h3 className="font-medium">Receive items</h3>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-sm">
              <span className="mb-1 block text-muted">Receipt date</span>
              <input type="date" value={receiptDate} onChange={(event) => setReceiptDate(event.target.value)} />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted">Packing slip / ref</span>
              <input value={referenceNumber} onChange={(event) => setReferenceNumber(event.target.value)} />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted">Location</span>
              <input value={location} onChange={(event) => setLocation(event.target.value)} />
            </label>
          </div>
          <table className="data-table text-sm">
            <thead>
              <tr>
                <th>Line</th>
                <th>Ordered</th>
                <th>Previously received</th>
                <th>Receiving now</th>
                <th>Remaining</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const remaining = line.quantity - line.quantity_received;
                return (
                  <tr key={line.id}>
                    <td>{line.description}</td>
                    <td>{line.quantity}</td>
                    <td>{line.quantity_received}</td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        max={remaining}
                        step="0.0001"
                        value={receiveQty[line.id] || ""}
                        onChange={(event) =>
                          setReceiveQty((current) => ({ ...current, [line.id]: event.target.value }))
                        }
                      />
                    </td>
                    <td>{remaining}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={pending} type="button" onClick={() => void receive()}>
              Record receipt
            </button>
            <button className="btn btn-ghost" type="button" onClick={() => setShowReceive(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {showBill ? (
        <div className="card p-4 space-y-3">
          <h3 className="font-medium">Create bill from PO</h3>
          <label className="text-sm">
            <span className="mb-1 block text-muted">Bill date</span>
            <input type="date" value={issueDate} onChange={(event) => setIssueDate(event.target.value)} />
          </label>
          <table className="data-table text-sm">
            <thead>
              <tr>
                <th>Line</th>
                <th>Received</th>
                <th>Billed</th>
                <th>Billable</th>
                <th>Billing now</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const billable = Math.max(line.quantity_received - line.quantity_billed, 0);
                return (
                  <tr key={line.id}>
                    <td>{line.description}</td>
                    <td>{line.quantity_received}</td>
                    <td>{line.quantity_billed}</td>
                    <td>{billable}</td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        max={billable}
                        step="0.0001"
                        value={billQty[line.id] || ""}
                        onChange={(event) =>
                          setBillQty((current) => ({ ...current, [line.id]: event.target.value }))
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={pending} type="button" onClick={() => void convertToBill()}>
              Create draft bill
            </button>
            <button className="btn btn-ghost" type="button" onClick={() => setShowBill(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}
