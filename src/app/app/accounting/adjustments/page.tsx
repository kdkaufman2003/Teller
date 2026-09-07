import Link from "next/link";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { accountingAdjustmentPath, routes } from "@/lib/routes";
import { redirect } from "next/navigation";

export default async function AdjustmentsPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const supabase = await createClient();
  const { data: adjustments } = await supabase
    .from("teller_adjusting_journal_entries")
    .select("id, adjustment_number, entry_date, memo, status, adjustment_type, created_at")
    .eq("organization_id", session.organization.id)
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <div className="space-y-6">
      <header className="page-header flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={routes.accounting} className="text-sm text-muted">
            ← Accounting
          </Link>
          <h1 className="mt-2">Adjusting journal entries</h1>
          <p className="text-muted">Draft, post, and reverse period-end adjustments.</p>
        </div>
        <Link href={`${routes.accountingAdjustments}/new`} className="btn btn-primary">
          New adjustment
        </Link>
      </header>

      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Number</th>
              <th>Date</th>
              <th>Memo</th>
              <th>Type</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(adjustments ?? []).map((row) => (
              <tr key={row.id as string}>
                <td>
                  <Link
                    href={accountingAdjustmentPath(row.id as string)}
                    className="text-sky hover:underline"
                  >
                    {row.adjustment_number as string}
                  </Link>
                </td>
                <td>{row.entry_date as string}</td>
                <td>{row.memo as string}</td>
                <td className="capitalize">{row.adjustment_type as string}</td>
                <td className="capitalize">{row.status as string}</td>
              </tr>
            ))}
            {!adjustments?.length ? (
              <tr>
                <td colSpan={5} className="text-muted py-6 text-center">
                  No adjustments yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
