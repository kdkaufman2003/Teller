import Link from "next/link";
import { routes } from "@/lib/routes";

export default function PayrollMappingsPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Payroll account mappings</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Map payroll component categories to GL accounts. Missing required mappings block posting and
        surface close-readiness findings.
      </p>
      <Link className="mt-6 inline-block text-sm text-muted-foreground hover:underline" href={routes.accountingPayroll}>
        ← Payroll & labor
      </Link>
    </div>
  );
}
