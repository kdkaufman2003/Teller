import Link from "next/link";
import { routes } from "@/lib/routes";

export default function PayrollReconciliationPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Payroll reconciliation</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Tie payroll run components to posted journals, GL wage expense, liabilities, clearing, and
        job-assigned vs unassigned labor economics.
      </p>
      <Link className="mt-6 inline-block text-sm text-muted-foreground hover:underline" href={routes.accountingPayroll}>
        ← Payroll & labor
      </Link>
    </div>
  );
}
