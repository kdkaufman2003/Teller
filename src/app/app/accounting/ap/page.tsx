import Link from "next/link";
import {
  authoritativeDocumentRemaining,
  enrichDocumentsWithAuthoritativePaid,
} from "@/lib/accounting/balances";
import { buildApDashboardSummary } from "@/lib/accounting/ap-dashboard";
import { asNumber, money, todayISO } from "@/lib/format";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

function agingBucket(daysPastDue: number): string {
  if (daysPastDue <= 0) return "current";
  if (daysPastDue <= 30) return "1-30";
  if (daysPastDue <= 60) return "31-60";
  if (daysPastDue <= 90) return "61-90";
  return "90+";
}

export default async function ApDashboardPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  const supabase = await createClient();
  const organizationId = session.organization.id;
  const asOf = todayISO();

  const summary = await buildApDashboardSummary(supabase, organizationId, asOf);

  const { data: bills } = await supabase
    .from("teller_documents")
    .select("id, total, due_date, issue_date")
    .eq("organization_id", organizationId)
    .eq("kind", "bill")
    .in("status", ["open", "partially_paid"]);

  const enriched = await enrichDocumentsWithAuthoritativePaid(supabase, organizationId, bills ?? []);
  const aging: Record<string, number> = {
    current: 0,
    "1-30": 0,
    "31-60": 0,
    "61-90": 0,
    "90+": 0,
  };

  for (const bill of enriched) {
    const remaining = await authoritativeDocumentRemaining(
      supabase,
      organizationId,
      bill.id as string,
      asNumber(bill.total),
    );
    if (remaining <= 0.009) continue;
    const due = (bill.due_date as string) || (bill.issue_date as string) || asOf;
    const daysPastDue = Math.floor(
      (new Date(`${asOf}T00:00:00`).getTime() - new Date(`${due}T00:00:00`).getTime()) / 86400000,
    );
    aging[agingBucket(daysPastDue)] += remaining;
  }

  const agingTotal = Object.values(aging).reduce((sum, value) => sum + value, 0);

  return (
    <div className="space-y-6">
      <div>
        <Link href={routes.accounting} className="text-sm text-muted">
          ← Accounting
        </Link>
        <h1 className="font-ledger mt-2 text-4xl text-navy">Accounts payable</h1>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {[
          ["Total AP", summary.totalAp],
          ["Overdue", summary.overdue],
          ["Due today", summary.dueToday],
          ["Due next 7 days", summary.dueNext7],
          ["Due next 30 days", summary.dueNext30],
          ["Awaiting approval", summary.awaitingApproval],
          ["Vendor credits", summary.unappliedVendorCredits],
          ["Open POs", summary.openPurchaseOrders],
        ].map(([label, value]) => (
          <div key={label as string} className="card p-4">
            <p className="text-sm text-muted">{label as string}</p>
            <p className="font-tabular text-2xl">
              {typeof value === "number" && label !== "Awaiting approval" && label !== "Open POs"
                ? money(value)
                : value}
            </p>
          </div>
        ))}
      </div>

      <section className="space-y-3">
        <h2 className="font-medium">Cash requirements</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="card p-4">
            <p className="text-sm text-muted">Next 7 days</p>
            <p className="font-tabular text-xl">{money(summary.cashRequired7)}</p>
          </div>
          <div className="card p-4">
            <p className="text-sm text-muted">Next 14 days</p>
            <p className="font-tabular text-xl">{money(summary.cashRequired14)}</p>
          </div>
          <div className="card p-4">
            <p className="text-sm text-muted">Next 30 days</p>
            <p className="font-tabular text-xl">{money(summary.cashRequired30)}</p>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">AP aging (bill remaining balances)</h2>
        <div className="card overflow-hidden">
          <table className="data-table">
            <thead>
              <tr>
                <th>Current</th>
                <th>1–30</th>
                <th>31–60</th>
                <th>61–90</th>
                <th>90+</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="font-tabular">{money(aging.current)}</td>
                <td className="font-tabular">{money(aging["1-30"])}</td>
                <td className="font-tabular">{money(aging["31-60"])}</td>
                <td className="font-tabular">{money(aging["61-90"])}</td>
                <td className="font-tabular">{money(aging["90+"])}</td>
                <td className="text-right font-tabular">{money(agingTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted">
          Aging reconciles to open AP: {money(agingTotal)} vs dashboard total {money(summary.totalAp)}
          {Math.abs(agingTotal - summary.totalAp) < 0.02 ? " ✓" : " (review)"}
        </p>
      </section>

      <p className="text-sm flex flex-wrap gap-4">
        <Link href={routes.bills} className="hover:underline">
          Bills →
        </Link>
        <Link href={routes.billPay} className="hover:underline">
          Pay bills →
        </Link>
        <Link href={routes.vendors} className="hover:underline">
          Vendors →
        </Link>
        <Link href={routes.purchaseOrders} className="hover:underline">
          Purchase orders →
        </Link>
      </p>
    </div>
  );
}
