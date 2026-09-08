import Link from "next/link";
import { routes } from "@/lib/routes";

export default function LaborByWorkerReportPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Labor by worker</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Hours, gross wages, direct vs indirect labor, and employer burden by worker.
      </p>
      <Link className="mt-6 inline-block text-sm text-muted-foreground hover:underline" href={routes.reports}>
        ← Reports
      </Link>
    </div>
  );
}
