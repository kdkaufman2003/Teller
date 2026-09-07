import Link from "next/link";
import { canPostAdjustments } from "@/lib/accounting/cpa";
import type { AdjustmentLine } from "@/lib/accounting/adjusting-journals";
import { money } from "@/lib/format";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { routes } from "@/lib/routes";
import { redirect, notFound } from "next/navigation";
import { AdjustmentActions } from "@/components/AdjustmentActions";

type PageProps = { params: Promise<{ id: string }> };

export default async function AdjustmentDetailPage({ params }: PageProps) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const { id } = await params;
  const supabase = await createClient();
  const organizationId = session.organization.id;
  const role = session.profile?.role ?? "viewer";
  const canAdjust = canPostAdjustments(role);

  const { data: adjustment } = await supabase
    .from("teller_adjusting_journal_entries")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();

  if (!adjustment) notFound();

  const lines = (adjustment.lines ?? []) as AdjustmentLine[];
  const accountIds = [...new Set(lines.map((line) => line.accountId))];
  const { data: accounts } = accountIds.length
    ? await supabase
        .from("teller_accounts")
        .select("id, code, name")
        .eq("organization_id", organizationId)
        .in("id", accountIds)
    : { data: [] };

  const accountMap = new Map(
    (accounts ?? []).map((account) => [
      account.id as string,
      `${account.code as string} · ${account.name as string}`,
    ]),
  );

  return (
    <div className="space-y-6">
      <header className="page-header">
        <Link href={routes.accountingAdjustments} className="text-sm text-muted">
          ← Adjustments
        </Link>
        <h1 className="mt-2">{adjustment.adjustment_number as string}</h1>
        <p className="text-muted capitalize">
          {adjustment.status as string} · {adjustment.entry_date as string}
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="card p-4 space-y-2">
          <p>
            <span className="text-muted">Memo:</span> {adjustment.memo as string}
          </p>
          {adjustment.reference ? (
            <p>
              <span className="text-muted">Reference:</span> {adjustment.reference as string}
            </p>
          ) : null}
          <p className="capitalize">
            <span className="text-muted">Type:</span> {adjustment.adjustment_type as string}
          </p>
        </div>
        {canAdjust ? (
          <AdjustmentActions
            adjustmentId={id}
            status={adjustment.status as string}
            entryDate={adjustment.entry_date as string}
          />
        ) : null}
      </div>

      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Account</th>
              <th className="text-right">Debit</th>
              <th className="text-right">Credit</th>
              <th>Memo</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={index}>
                <td>{accountMap.get(line.accountId) ?? line.accountId}</td>
                <td className="text-right font-tabular">{money(line.debit ?? 0)}</td>
                <td className="text-right font-tabular">{money(line.credit ?? 0)}</td>
                <td>{line.memo ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
