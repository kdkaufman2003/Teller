import Link from "next/link";
import { routes } from "@/lib/routes";

export default function PayrollWorkersPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Workers</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Lightweight accounting identity — display name, provider worker ID, and default labor accounts.
        Teller does not store SSN, bank accounts, or tax forms.
      </p>
      <Link className="mt-6 inline-block text-sm text-muted-foreground hover:underline" href={routes.accountingPayroll}>
        ← Payroll & labor
      </Link>
    </div>
  );
}
