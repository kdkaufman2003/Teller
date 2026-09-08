import Link from "next/link";
import { routes } from "@/lib/routes";

export default function PayrollImportPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Import payroll</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Provider-neutral import via CSV or JSON. Payloads are normalized before validation — provider
        structures do not leak into the accounting engine.
      </p>
      <Link className="mt-6 inline-block text-sm text-muted-foreground hover:underline" href={routes.accountingPayroll}>
        ← Payroll & labor
      </Link>
    </div>
  );
}
