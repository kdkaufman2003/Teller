import Link from "next/link";
import { routes } from "@/lib/routes";

export default function InventoryCountsPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Physical counts</h1>
      <p className="mt-2 text-sm text-muted-foreground">Draft → review → post count variances as inventory adjustments.</p>
      <Link className="mt-6 inline-block text-sm text-muted-foreground hover:underline" href={routes.accountingInventory}>
        ← Inventory
      </Link>
    </div>
  );
}
