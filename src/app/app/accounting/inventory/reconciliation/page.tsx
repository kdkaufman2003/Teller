import Link from "next/link";
import { routes } from "@/lib/routes";
import { ACCOUNTANT_MODE_INVENTORY_LABELS } from "@/lib/accounting/inventory/reporting";

export default function InventoryReconciliationPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold">{ACCOUNTANT_MODE_INVENTORY_LABELS.glReconciliation}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Compare inventory subledger value to inventory asset GL balance. Difference should be zero
        except documented reconciling items.
      </p>
      <p className="mt-4 text-sm text-muted-foreground">
        Requires migration 031 applied and posted inventory activity.
      </p>
      <Link className="mt-6 inline-block text-sm text-muted-foreground hover:underline" href={routes.accountingInventory}>
        ← Inventory
      </Link>
    </div>
  );
}
