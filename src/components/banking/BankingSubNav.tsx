"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { routes } from "@/lib/routes";

const LINKS = [
  { href: routes.banking, label: "Transactions" },
  { href: routes.bankingReconcile, label: "Reconcile" },
  { href: routes.bankingReconciliations, label: "Reconciliation history" },
];

export function BankingSubNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Banking sections"
      className="flex flex-wrap gap-2 border-b border-rule pb-3"
    >
      {LINKS.map((link) => {
        const active =
          link.href === routes.banking
            ? pathname === routes.banking
            : pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={active ? "tab-chip tab-chip-active" : "tab-chip"}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
