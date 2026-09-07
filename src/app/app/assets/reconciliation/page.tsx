import { redirect } from "next/navigation";
import { buildFixedAssetReconciliationReport } from "@/lib/accounting/fixed-asset-reconciliation";
import { listUnassignedFixedAssetActivity } from "@/lib/accounting/unassigned-fixed-asset-activity";
import { money } from "@/lib/format";
import { routes } from "@/lib/routes";
import { getSessionContext, hasModule } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export default async function AssetReconciliationPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  if (!hasModule(session.settings, "fixed_assets")) redirect(routes.app);

  const supabase = await createClient();
  const report = await buildFixedAssetReconciliationReport(supabase, session.organization.id);
  const unassigned = await listUnassignedFixedAssetActivity(supabase, session.organization.id);

  return (
    <div className="space-y-6">
      <header className="page-header">
        <h1>Fixed asset reconciliation</h1>
      </header>
      <div className="grid gap-4 md:grid-cols-3">
        {[
          ["Fixed asset cost", report.fixedAssetCost],
          ["Accumulated depreciation", report.accumulatedDepreciation],
          ["Depreciation expense", report.depreciationExpense],
        ].map(([label, slice]) => (
          <div key={label as string} className="card p-4 space-y-2">
            <h2 className="font-medium">{label as string}</h2>
            <p className="text-sm">GL: {money((slice as { glActivity: number }).glActivity)}</p>
            <p className="text-sm">
              Subledger:{" "}
              {money(
                (slice as { subledgerCost?: number; subledgerAccumDepr?: number; subledgerDeprExpense?: number })
                  .subledgerCost ??
                  (slice as { subledgerAccumDepr?: number }).subledgerAccumDepr ??
                  (slice as { subledgerDeprExpense?: number }).subledgerDeprExpense ??
                  0,
              )}
            </p>
            <p className="text-sm">Unassigned: {money((slice as { unassigned: number }).unassigned)}</p>
            <p className="font-medium">Difference: {money((slice as { difference: number }).difference)}</p>
          </div>
        ))}
      </div>
      <div className="card overflow-hidden">
        <div className="border-b px-4 py-3 font-medium">Unassigned fixed asset GL activity</div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Account</th>
              <th>Source</th>
              <th className="text-right">Debit</th>
              <th className="text-right">Credit</th>
            </tr>
          </thead>
          <tbody>
            {unassigned.map((row) => (
              <tr key={`${row.entryId}-${row.accountCode}`}>
                <td>{row.entryDate}</td>
                <td>
                  {row.accountCode} {row.accountName}
                </td>
                <td>{row.sourceKind ?? "—"}</td>
                <td className="text-right font-tabular">{money(row.debit)}</td>
                <td className="text-right font-tabular">{money(row.credit)}</td>
              </tr>
            ))}
            {!unassigned.length ? (
              <tr>
                <td colSpan={5} className="text-muted py-6 text-center">
                  No unassigned activity.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
