import { AccountingView } from "@/components/AccountingView";
import {
  canExportBooks,
  canManagePeriodClose,
  canPostAdjustments,
  parseCpaMode,
} from "@/lib/accounting/cpa";
import {
  booksClosedThrough,
  nextCloseablePeriodEnd,
  recentMonthPeriods,
  type PeriodCloseRow,
} from "@/lib/accounting/periods";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { routes } from "@/lib/routes";
import { redirect } from "next/navigation";

export default async function AccountingPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const supabase = await createClient();
  const organizationId = session.organization.id;
  const role = session.profile?.role ?? "viewer";
  const answers = session.settings?.answers ?? {};
  const cpaMode = parseCpaMode(answers.cpaMode);

  const [{ data: closes }, { data: accounts }] = await Promise.all([
    supabase
      .from("teller_period_closes")
      .select("id, period_end, notes, closed_at, closed_by")
      .eq("organization_id", organizationId)
      .order("period_end", { ascending: false })
      .limit(24),
    supabase
      .from("teller_accounts")
      .select("id, code, name")
      .eq("organization_id", organizationId)
      .order("code"),
  ]);

  const closeRows = (closes ?? []) as PeriodCloseRow[];
  const closedThrough = booksClosedThrough(closeRows);

  return (
    <div className="space-y-6">
      <header className="page-header">
        <h1>Accounting</h1>
        <p>Period close, CPA exports, and manual adjustments</p>
      </header>
      <AccountingView
        closedThrough={closedThrough}
        nextClose={nextCloseablePeriodEnd(closedThrough)}
        periods={recentMonthPeriods(12, new Date(), closedThrough)}
        closes={closeRows}
        accounts={accounts ?? []}
        canManageClose={canManagePeriodClose(role)}
        canAdjust={canPostAdjustments(role)}
        canExport={canExportBooks(role, cpaMode)}
        cpaMode={cpaMode}
        role={role}
      />
    </div>
  );
}
