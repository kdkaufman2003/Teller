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
        <div className="font-ledger text-2xl tracking-tight">Teller</div>
        <nav className="flex items-center gap-3 text-sm">
          <Link href={routes.login} className="btn btn-ghost">
            Sign in
          </Link>
          <Link href={ctaHref} className="btn btn-primary">
            {session ? "Open books" : "Set up books"}
          </Link>
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-6 pb-20 pt-10">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-brass-deep">
          Its own program
        </p>
        <h1 className="font-ledger mt-3 max-w-3xl text-5xl leading-[1.1] text-navy">
          Industry books that stand alone — or attach to Hassle Free AC.
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-muted">
          Teller is a full ledger: invoices, jobs, expenses, and a chart of
          accounts tailored to your industry. Run it for any company, or attach
          to the HFAC Quoter stack when you want dealers and won quotes to flow
          in. Detach anytime; your books stay in Teller.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link href={`${routes.setup}?attach=hasslefreeac`} className="btn btn-brass">
            Attach to Hassle Free AC
          </Link>
          <Link href={routes.setup} className="btn btn-primary">
            Standalone setup
          </Link>
          <Link href={routes.login} className="btn btn-ghost">
            Sign in
          </Link>
        </div>

        <section className="mt-16 grid gap-4 md:grid-cols-3">
          {[
            {
              title: "Standalone",
              body: "Pick HVAC, SaaS, or general. Your Supabase, your company, no partner required.",
            },
            {
              title: "Attached",
              body: "Link to Hassle Free AC + Quoter. Sync dealers and won quotes; books remain in Teller.",
            },
            {
              title: "Same stack",
              body: "GitHub, Supabase, Vercel — sibling to Quoter, not a module buried inside it.",
            },
          ].map((item) => (
            <article key={item.title} className="card p-5">
              <h2 className="font-ledger text-xl text-navy">{item.title}</h2>
              <p className="mt-2 text-sm leading-6 text-muted">{item.body}</p>
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}
