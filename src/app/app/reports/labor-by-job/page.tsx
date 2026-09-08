import Link from "next/link";
import { routes } from "@/lib/routes";

export default function LaborByJobReportPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Labor by job</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Direct gross labor, employer burden, total labor cost, and labor % of revenue per job.
      </p>
      <Link className="mt-6 inline-block text-sm text-muted-foreground hover:underline" href={routes.reports}>
        ← Reports
      </Link>
    </div>
  );
}
