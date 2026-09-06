"use client";

import { PaymentReverseAction } from "@/components/InvoiceSettlementActions";

export function DocumentPaymentHistory({
  payments,
}: {
  payments: {
    paymentId: string;
    amount: number;
    paymentDate: string;
    method?: string | null;
    reference?: string | null;
    status: string;
    canReverse: boolean;
  }[];
}) {
  if (!payments.length) return null;

  return (
    <div className="card overflow-hidden">
      <div className="border-b border-rule px-4 py-3 text-sm font-medium">Payment history</div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Method</th>
            <th>Reference</th>
            <th className="text-right">Amount</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {payments.map((payment) => (
            <tr key={payment.paymentId}>
              <td>{payment.paymentDate}</td>
              <td>{payment.method || "—"}</td>
              <td>{payment.reference || "—"}</td>
              <td className="text-right font-tabular">${payment.amount.toFixed(2)}</td>
              <td className="text-right">
                {payment.canReverse ? (
                  <PaymentReverseAction paymentId={payment.paymentId} status={payment.status} />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
