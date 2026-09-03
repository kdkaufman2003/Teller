import Link from "next/link";
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
    <div className="min-h-screen bg-paper text-ink">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <div className="font-ledger text-2xl tracking-tight text-navy">Teller</div>
        <nav className="flex items-center gap-3 text-sm">
          <Link href={routes.login} className="btn btn-ghost">
            Sign in
          </Link>
          <Link href={ctaHref} className="btn btn-primary">
            {session ? "Open dashboard" : "Start free setup"}
          </Link>
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-6 pb-20 pt-6">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-brass-deep">
          Industry accounting
        </p>
        <h1 className="font-ledger mt-3 max-w-3xl text-5xl leading-[1.1] text-navy">
          Books built for how your business actually works.
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-muted">
          Teller sets up a professional chart of accounts, invoicing, expenses,
          and reporting around your industry — HVAC, SaaS, trades, or general
          business. Connect your existing tools when you are ready.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href={routes.signup} className="btn btn-brass">
            Create your account
          </Link>
          <Link href={routes.login} className="btn btn-ghost">
            Sign in
          </Link>
        </div>

        <section className="mt-16">
          <h2 className="text-sm font-medium uppercase tracking-[0.2em] text-brass-deep">
            Core capabilities
          </h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                title: "Invoicing & AR",
                body: "Draft, post, and collect on invoices with double-entry ledger posting.",
              },
              {
                title: "Expenses & AP",
                body: "Record vendor spend against the right accounts and track payables.",
              },
              {
                title: "Industry chart of accounts",
                body: "Setup questions seed accounts for equipment, labor, subscriptions, and more.",
              },
              {
                title: "Job costing",
                body: "Track installs, projects, or service jobs with quoted vs billed amounts.",
              },
              {
                title: "Financial reporting",
                body: "Trial balance, receivables, and payables at a glance on your dashboard.",
              },
              {
                title: "Integrations",
                body: "Connect quoting and operational tools to import customers and won deals.",
              },
            ].map((item) => (
              <article key={item.title} className="card p-5">
                <h3 className="font-ledger text-xl text-navy">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted">{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-16">
          <h2 className="font-ledger text-3xl text-navy">Built for multiple industries</h2>
          <p className="mt-2 max-w-2xl text-muted">
            One platform, configured during setup — not a generic template you
            have to fight with.
          </p>
            <ul className="mt-8 grid gap-4 md:grid-cols-3">
              {[
                {
                  title: "Trades & field service",
                  body: "HVAC, electrical, plumbing, roofing, mechanical, and GC — job costing and equipment vs labor.",
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
                <h3 className="font-ledger text-xl text-navy">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted">{item.body}</p>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="border-t border-rule">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6 text-sm text-muted">
          <span className="font-ledger text-navy">Teller</span>
          <span>Industry accounting software</span>
        </div>
      </footer>
    </div>
  );
}
