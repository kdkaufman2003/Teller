"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { EntitySwitcher } from "@/components/legal-entity/EntitySwitcher";
import { PresentationModeToggle } from "@/components/ui/PresentationModeToggle";
import { routes } from "@/lib/routes";
import { getHfacPlatformUrl } from "@/lib/partners/registry";
import { createClient } from "@/lib/supabase/client";
import type { PresentationMode } from "@/lib/accounting/presentation-mode";
import { navItemsForMode } from "@/lib/ux/navigation";
import type { ActiveLegalEntitySummary } from "@/types";

export function AppShell({
  companyName,
  industryName,
  partnerName,
  attached,
  modules,
  labels,
  activeLegalEntity,
  accessibleLegalEntities,
  showEntitySwitcher,
  presentationMode = "accountant",
  children,
}: {
  companyName: string;
  industryName: string;
  partnerName: string | null;
  attached: boolean;
  modules: string[];
  labels: Record<string, string>;
  activeLegalEntity?: ActiveLegalEntitySummary | null;
  accessibleLegalEntities?: ActiveLegalEntitySummary[];
  showEntitySwitcher?: boolean;
  presentationMode?: PresentationMode;
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

  const items = navItemsForMode(presentationMode, modules, labels);

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
        <EntitySwitcher
          activeLegalEntity={activeLegalEntity}
          accessibleEntities={accessibleLegalEntities}
          showEntitySwitcher={Boolean(showEntitySwitcher)}
        />
        <div className="mt-3">
          <PresentationModeToggle mode={presentationMode} />
        </div>
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
        <button
          type="button"
          onClick={signOut}
          className="mt-4 rounded-lg border border-white/25 px-3 py-2 text-sm text-white hover:bg-white/8"
        >
          Sign out
        </button>
      </aside>
      <div className="min-w-0 flex-1">
        <main key={activeLegalEntity?.id ?? "default-entity"} className="mx-auto max-w-6xl px-6 py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
