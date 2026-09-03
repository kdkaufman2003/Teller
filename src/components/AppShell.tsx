"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BookOpen,
  Briefcase,
  FileText,
  LayoutDashboard,
  LogOut,
  Plug,
  Receipt,
  Settings,
  Users,
} from "lucide-react";
import { routes } from "@/lib/routes";
import { getQuoterUrl } from "@/lib/partners/registry";
import { createClient } from "@/lib/supabase/client";
import type { LucideIcon } from "lucide-react";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  module?: string;
};

const NAV: NavItem[] = [
  { href: routes.app, label: "Dashboard", icon: LayoutDashboard },
  { href: routes.invoices, label: "Invoices", icon: FileText },
  { href: routes.customers, label: "Customers", icon: Users },
  { href: routes.jobs, label: "Jobs", icon: Briefcase, module: "jobs" },
  { href: routes.expenses, label: "Expenses", icon: Receipt },
  { href: routes.accounts, label: "Chart of accounts", icon: BookOpen },
  { href: routes.ledger, label: "General ledger", icon: BookOpen },
  { href: routes.settings, label: "Settings", icon: Settings },
];

export function AppShell({
  companyName,
  industryName,
  partnerName,
  attached,
  modules,
  labels,
  children,
}: {
  companyName: string;
  industryName: string;
  partnerName: string | null;
  attached: boolean;
  modules: string[];
  labels: Record<string, string>;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const partnerAppUrl = getQuoterUrl();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push(routes.home);
    router.refresh();
  }

  const items = NAV.filter(
    (item) => !item.module || modules.includes(item.module),
  ).map((item) => {
    if (item.href === routes.customers) {
      return { ...item, label: labels.customer || "Customers" };
    }
    if (item.href === routes.jobs) {
      return { ...item, label: labels.job || "Jobs" };
    }
    return item;
  });

  return (
    <div className="flex min-h-screen bg-surface">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar text-white">
        <div className="border-b border-white/10 px-4 py-5">
          <Link href={routes.app} className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-sm font-bold">
              T
            </div>
            <span className="text-base font-semibold tracking-tight">Teller</span>
          </Link>
          <p className="mt-3 truncate text-sm font-medium text-white/90">
            {companyName}
          </p>
          <p className="mt-0.5 text-xs text-sidebar-muted">{industryName}</p>
          {attached && partnerName ? (
            <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white/80">
              <Plug className="h-3 w-3" />
              {partnerName}
            </p>
          ) : null}
        </div>

        <nav className="flex-1 space-y-0.5 px-2 py-3">
          {items.map((item) => {
            const active =
              item.href === routes.app
                ? pathname === routes.app
                : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? "bg-white/10 text-white"
                    : "text-white/65 hover:bg-white/5 hover:text-white"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0 opacity-80" strokeWidth={1.75} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-white/10 p-3 space-y-1">
          {attached && partnerAppUrl && modules.includes("quoter") ? (
            <a
              href={partnerAppUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-md px-3 py-2 text-xs text-white/70 hover:bg-white/5 hover:text-white"
            >
              <Plug className="h-3.5 w-3.5" />
              Open connected app
            </a>
          ) : null}
          <button
            type="button"
            onClick={signOut}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-white/65 hover:bg-white/5 hover:text-white"
          >
            <LogOut className="h-4 w-4" strokeWidth={1.75} />
            Sign out
          </button>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </div>
    </div>
  );
}
