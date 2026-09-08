import Link from "next/link";
import { routes } from "@/lib/routes";

export default function PayrollLiabilitiesPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Payroll liabilities & clearing</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Recognition creates liabilities and payroll clearing. Cash settlements relieve liabilities
        without duplicating wage expense — match bank withdrawals in Banking.
      </p>
      <Link className="mt-6 inline-block text-sm text-muted-foreground hover:underline" href={routes.accountingPayroll}>
        ← Payroll & labor
      </Link>
    </div>
  );
}
