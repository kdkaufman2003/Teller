import Link from "next/link";
import { routes } from "@/lib/routes";
import { OWNER_MODE_INVENTORY_LABELS } from "@/lib/accounting/inventory/reporting";

const links = [
  { href: routes.accountingInventoryItems, label: "Items & SKUs" },
  { href: routes.accountingInventoryLocations, label: "Locations" },
  { href: routes.accountingInventoryMovements, label: "Movements" },
  { href: routes.accountingInventoryCounts, label: "Physical counts" },
  { href: routes.accountingInventoryReconciliation, label: "Reconciliation" },
  { href: routes.reportsInventoryValuation, label: OWNER_MODE_INVENTORY_LABELS.inventoryValue },
  { href: routes.reportsInventoryByLocation, label: OWNER_MODE_INVENTORY_LABELS.inventoryByLocation },
  { href: routes.reportsJobMaterialUsage, label: OWNER_MODE_INVENTORY_LABELS.partsUsedOnJobs },
];

export default function InventoryHubPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Inventory</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Inventory accounting and stock control — weighted-average costing, locations, job material
        usage, and GL reconciliation. Teller owns accounting truth; operational systems may feed
        events later.
      </p>
      <ul className="mt-6 grid gap-3 sm:grid-cols-2">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              className="block rounded-lg border border-border p-4 text-sm font-medium hover:bg-muted/50"
              href={link.href}
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
      <Link className="mt-6 inline-block text-sm text-muted-foreground hover:underline" href={routes.accounting}>
        ← Accounting
      </Link>
    </div>
  );
}
