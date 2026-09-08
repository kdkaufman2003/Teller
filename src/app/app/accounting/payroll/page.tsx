import Link from "next/link";
import { routes } from "@/lib/routes";

const links = [
  { href: routes.accountingPayrollRuns, label: "Payroll runs" },
  { href: routes.accountingPayrollImport, label: "Import payroll" },
  { href: routes.accountingPayrollWorkers, label: "Workers" },
  { href: routes.accountingPayrollMappings, label: "Account mappings" },
  { href: routes.accountingPayrollLiabilities, label: "Liabilities & clearing" },
  { href: routes.accountingPayrollReconciliation, label: "Reconciliation" },
  { href: routes.reportsLaborByJob, label: "Labor by job" },
  { href: routes.reportsLaborByWorker, label: "Labor by worker" },
  { href: routes.reportsUnallocatedLabor, label: "Unallocated labor" },
];

export default function PayrollHubPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Payroll & labor</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Teller records payroll and labor economics from external payroll providers — not payroll
        calculation, tax filing, or direct deposit. Import pay runs, allocate labor to jobs, and
        reconcile liabilities to cash.
      </p>
      <ul className="mt-6 grid gap-3 sm:grid-cols-2">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              className="block rounded-lg border border-border p-4 text-sm font-medium hover:bg-muted/50"
              href={link.href}
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
      <Link className="mt-6 inline-block text-sm text-muted-foreground hover:underline" href={routes.accounting}>
        ← Accounting
      </Link>
    </div>
  );
}
