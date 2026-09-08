import Link from "next/link";
import { routes } from "@/lib/routes";

export default function UnallocatedLaborReportPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Unallocated labor</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Payroll gross not assigned to jobs — overhead, training, shop time, and review items.
      </p>
      <Link className="mt-6 inline-block text-sm text-muted-foreground hover:underline" href={routes.reports}>
        ← Reports
      </Link>
    </div>
  );
}
