"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { routes } from "@/lib/routes";

const NAV_ITEMS = [
  { href: routes.taxSettings, label: "Overview" },
  { href: routes.taxPeriods, label: "Filing periods" },
  { href: routes.taxReports, label: "Reports" },
  { href: routes.taxConfigure, label: "Settings" },
  { href: routes.taxExemptions, label: "Exemptions" },
];

export function TaxNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Tax navigation" className="flex flex-wrap gap-2 border-b pb-3">
      {NAV_ITEMS.map((item) => {
        const active =
          pathname === item.href ||
          (item.href === routes.taxPeriods && pathname.startsWith(`${routes.taxPeriods}/`));
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`rounded-md px-3 py-1.5 text-sm ${active ? "bg-muted font-medium" : "text-muted hover:bg-muted/60"}`}
            aria-current={active ? "page" : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
