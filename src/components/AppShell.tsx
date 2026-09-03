"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { routes } from "@/lib/routes";
import { getHfacPlatformUrl } from "@/lib/partners/registry";
import { createClient } from "@/lib/supabase/client";

type NavItem = { href: string; label: string; module?: string };

const NAV: NavItem[] = [
  { href: routes.app, label: "Dashboard" },
  { href: routes.invoices, label: "Invoices" },
  { href: routes.customers, label: "Customers" },
  { href: routes.jobs, label: "Jobs", module: "jobs" },
  { href: routes.expenses, label: "Expenses" },
  { href: routes.accounts, label: "Accounts" },
  { href: routes.ledger, label: "Ledger" },
  { href: routes.settings, label: "Settings" },
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
  const partnerAppUrl = getHfacPlatformUrl();

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
    <div className="flex min-h-screen bg-paper">
      <aside className="flex w-64 flex-col bg-navy px-4 py-6 text-white">
        <Link href={routes.app} className="font-ledger text-2xl tracking-tight">
          Teller
        </Link>
        {attached && partnerName ? (
          <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-brass">
            Connected · {partnerName}
          </p>
        ) : (
          <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-white/45">
            Standalone
          </p>
        )}
        <p className="mt-1 text-xs text-white/60">{companyName}</p>
        <p className="text-[11px] uppercase tracking-[0.16em] text-white/45">
          {industryName}
        </p>
        {attached && partnerAppUrl && (modules.includes("hfac") || modules.includes("quoter")) ? (
          <a
            href={partnerAppUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-3 text-xs text-sky-200 underline-offset-2 hover:underline"
          >
            Open Hassle Free AC ↗
          </a>
        ) : null}
        <nav className="mt-8 flex flex-1 flex-col gap-1 text-sm">
          {items.map((item) => {
            const active =
              item.href === routes.app
                ? pathname === routes.app
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-lg px-3 py-2 ${
                  active ? "bg-white/12 text-white" : "text-white/70 hover:bg-white/8"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <button type="button" onClick={signOut} className="btn btn-ghost mt-4 text-white">
          Sign out
        </button>
      </aside>
      <div className="min-w-0 flex-1">
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </div>
    </div>
  );
}
