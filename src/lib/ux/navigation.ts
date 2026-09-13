import { routes } from "@/lib/routes";
import type { PresentationMode } from "@/lib/accounting/presentation-mode";

export type NavItem = {
  href: string;
  label: string;
  module?: string;
  accountantOnly?: boolean;
  ownerPrimary?: boolean;
};

export const APP_NAV: NavItem[] = [
  { href: routes.app, label: "Dashboard", ownerPrimary: true },
  { href: routes.invoices, label: "Money in", ownerPrimary: true },
  { href: routes.customers, label: "Customers", ownerPrimary: true },
  { href: routes.bills, label: "Money out", ownerPrimary: true },
  { href: routes.vendors, label: "Vendors" },
  { href: routes.banking, label: "Banking", ownerPrimary: true },
  { href: routes.jobs, label: "Jobs", module: "jobs", ownerPrimary: true },
  { href: routes.reports, label: "Reports", ownerPrimary: true },
  { href: routes.expenses, label: "Expenses" },
  { href: routes.purchaseOrders, label: "Purchase orders" },
  { href: routes.apDashboard, label: "AP dashboard", accountantOnly: true },
  { href: routes.assets, label: "Fixed assets", module: "fixed_assets" },
  { href: routes.planning, label: "Planning", accountantOnly: true },
  { href: routes.accounts, label: "Chart of accounts", accountantOnly: true },
  { href: routes.ledger, label: "General ledger", accountantOnly: true },
  { href: routes.accountingWorkspace, label: "Accountant workspace", accountantOnly: true },
  { href: routes.accounting, label: "Accounting", accountantOnly: true },
  { href: routes.accountingSchedules, label: "Schedules", accountantOnly: true },
  { href: routes.accountingClose, label: "Month-end close", accountantOnly: true },
  { href: routes.companiesOverview, label: "All companies", accountantOnly: true },
  { href: routes.settings, label: "Settings" },
];

export function navItemsForMode(
  mode: PresentationMode,
  modules: string[],
  labels: Record<string, string>,
): NavItem[] {
  const filtered = APP_NAV.filter((item) => {
    if (item.module && !modules.includes(item.module)) return false;
    if (mode === "owner" && item.accountantOnly) return false;
    return true;
  });

  return filtered.map((item) => {
    if (item.href === routes.customers) {
      return { ...item, label: labels.customer ? `${labels.customer}s` : "Customers" };
    }
    if (item.href === routes.invoices && mode === "accountant") {
      return { ...item, label: "Invoices" };
    }
    if (item.href === routes.bills && mode === "accountant") {
      return { ...item, label: "Bills" };
    }
    if (item.href === routes.jobs) {
      return { ...item, label: labels.job ? `${labels.job}s` : "Jobs" };
    }
    if (item.href === routes.ledger && mode === "owner") {
      return { ...item, label: "Ledger detail" };
    }
    return item;
  });
}
