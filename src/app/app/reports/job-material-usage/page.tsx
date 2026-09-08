import Link from "next/link";
import { routes } from "@/lib/routes";
import { OWNER_MODE_INVENTORY_LABELS } from "@/lib/accounting/inventory/reporting";

export default function JobMaterialUsageReportPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold">{OWNER_MODE_INVENTORY_LABELS.partsUsedOnJobs}</h1>
      <p className="mt-2 text-sm text-muted-foreground">Job, item, quantity, and material cost from inventory issues.</p>
      <Link className="mt-6 inline-block text-sm text-muted-foreground hover:underline" href={routes.reports}>
        ← Reports
      </Link>
    </div>
  );
}
