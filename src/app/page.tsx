import Link from "next/link";
import {
  BarChart3,
  Building2,
  FileText,
  Layers,
  Plug,
  Receipt,
} from "lucide-react";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";

export default async function HomePage() {
  const session = await getSessionContext().catch(() => null);
  const ctaHref = session?.organization
    ? routes.app
    : session
      ? routes.setup
      : routes.signup;

  return (
    <div className="min-h-screen bg-surface text-ink">
      <header className="border-b border-border bg-surface-raised">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-sm font-bold text-white">
              T
            </div>
            <span className="text-lg font-semibold tracking-tight">Teller</span>
          </div>
          <nav className="flex items-center gap-3 text-sm">
            <Link href={routes.login} className="btn btn-ghost">
              Sign in
            </Link>
            <Link href={ctaHref} className="btn btn-primary">
              {session ? "Open dashboard" : "Start free setup"}
            </Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="border-b border-border bg-surface-raised">
          <div className="mx-auto max-w-6xl px-6 py-16 md:py-24">
            <p className="text-sm font-medium text-accent">Industry accounting</p>
            <h1 className="mt-3 max-w-2xl text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
              Books built for how your business actually works.
            </h1>
            <p className="mt-5 max-w-xl text-lg text-muted">
              Teller sets up a professional chart of accounts, invoicing, expenses,
              and reporting around your industry — HVAC, SaaS, trades, or general
              business. Connect your existing tools when you are ready.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href={routes.signup} className="btn btn-primary">
                Create your account
              </Link>
              <Link href={routes.login} className="btn btn-secondary">
                Sign in
              </Link>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted">
            Core capabilities
          </h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                icon: FileText,
                title: "Invoicing & AR",
                body: "Draft, post, and collect on invoices with double-entry ledger posting.",
              },
              {
                icon: Receipt,
                title: "Expenses & AP",
                body: "Record vendor spend against the right accounts and track payables.",
              },
              {
                icon: Layers,
                title: "Industry chart of accounts",
                body: "Setup questions seed accounts for equipment, labor, subscriptions, and more.",
              },
              {
                icon: Building2,
                title: "Job costing",
                body: "Track installs, projects, or service jobs with quoted vs billed amounts.",
              },
              {
                icon: BarChart3,
                title: "Financial reporting",
                body: "Trial balance, receivables, and payables at a glance on your dashboard.",
              },
              {
                icon: Plug,
                title: "Integrations",
                body: "Connect quoting and operational tools to import customers and won deals.",
              },
            ].map((item) => (
              <article key={item.title} className="card p-5">
                <item.icon className="h-5 w-5 text-accent" strokeWidth={1.75} />
                <h3 className="mt-3 font-semibold text-ink">{item.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="border-t border-border bg-surface-raised">
          <div className="mx-auto max-w-6xl px-6 py-16">
            <h2 className="text-2xl font-semibold tracking-tight">
              Built for multiple industries
            </h2>
            <p className="mt-2 max-w-2xl text-muted">
              One platform, configured during setup — not a generic template you
              have to fight with.
            </p>
            <ul className="mt-8 grid gap-4 md:grid-cols-3">
              {[
                {
                  title: "HVAC & trades",
                  body: "Equipment vs labor revenue, job costing, warranty reserves, dealer books.",
                },
                {
                  title: "SaaS",
                  body: "Subscription revenue, deferred revenue, MRR-focused dashboard modules.",
                },
                {
                  title: "General business",
                  body: "A clean starting chart of accounts you can grow into any operation.",
                },
              ].map((item) => (
                <li key={item.title} className="card p-5">
                  <h3 className="font-semibold">{item.title}</h3>
                  <p className="mt-2 text-sm text-muted">{item.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6 text-sm text-muted">
          <span>Teller</span>
          <span>Industry accounting software</span>
        </div>
      </footer>
    </div>
  );
}
