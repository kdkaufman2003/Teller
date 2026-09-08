import Link from "next/link";
import { routes } from "@/lib/routes";

export default function PayrollRunsPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Payroll runs</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Review imported pay runs, preview journal economics, and post recognition entries. Posted runs
        are immutable — corrections use reversal and replacement.
      </p>
      <Link className="mt-6 inline-block text-sm text-muted-foreground hover:underline" href={routes.accountingPayroll}>
        ← Payroll & labor
      </Link>
    </div>
  );
}
