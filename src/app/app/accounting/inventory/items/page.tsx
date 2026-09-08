import Link from "next/link";
import { routes } from "@/lib/routes";

export default function InventoryItemsPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Inventory items</h1>
      <p className="mt-2 text-sm text-muted-foreground">SKU master with valuation method and GL account mappings.</p>
      <Link className="mt-6 inline-block text-sm text-muted-foreground hover:underline" href={routes.accountingInventory}>
        ← Inventory
      </Link>
    </div>
  );
}
