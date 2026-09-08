import Link from "next/link";
import { routes } from "@/lib/routes";

export default function InventoryLocationsPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Inventory locations</h1>
      <p className="mt-2 text-sm text-muted-foreground">Warehouses, vehicles, staging areas, and other stock locations.</p>
      <Link className="mt-6 inline-block text-sm text-muted-foreground hover:underline" href={routes.accountingInventory}>
        ← Inventory
      </Link>
    </div>
  );
}
