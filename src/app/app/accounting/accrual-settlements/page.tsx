import Link from "next/link";
import { routes } from "@/lib/routes";

export default function AccrualSettlementsPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Accrual settlements</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        When a vendor bill arrives for a previously accrued expense, apply the accrual during bill
        posting to clear accrued liability without duplicating expense.
      </p>
      <div className="mt-6 space-y-4">
        <section className="rounded-lg border border-border p-4">
          <h2 className="text-sm font-medium">Create settlement</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Use <Link className="underline" href={routes.billNew}>New bill</Link> and select
            &quot;Apply existing accrual&quot; to preview and post the settlement journal with the bill.
          </p>
        </section>
        <section className="rounded-lg border border-border p-4">
          <h2 className="text-sm font-medium">Reports</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>
              <Link className="underline" href="/api/accounting/accrual-settlements/variance-report">
                Accrual variance report (API)
              </Link>
            </li>
            <li>
              <Link className="underline" href={routes.accountingSchedulesAccruals}>
                Accrual schedules
              </Link>
            </li>
          </ul>
        </section>
        <Link className="inline-block text-sm text-muted-foreground hover:underline" href={routes.accounting}>
          ← Accounting
        </Link>
      </div>
    </div>
  );
}
