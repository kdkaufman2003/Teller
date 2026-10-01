import Link from "next/link";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";

export default async function OpsHomePage() {
  const session = await getSessionContext();
  const booksHref = session?.organization ? routes.app : routes.setup;

  return (
    <div className="space-y-6">
      <header className="page-header">
        <h1>Operator console</h1>
        <p>
          Manage customer accounts here. This is not your personal sign-in setup — use{" "}
          <Link href={booksHref} className="text-sky hover:underline">
            Books
          </Link>{" "}
          for your company ledger{session?.organization ? ` (${session.organization.name})` : ""}.
        </p>
      </header>

      <section className="card p-4">
        <h2 className="font-medium">Users & credentials (customers)</h2>
        <p className="text-muted mb-3 text-sm">
          Create a login for someone else: new customer organization or an additional member on an
          existing org. Do not use this for your operator account.
        </p>
        <Link href="/ops/users/new" className="btn btn-primary">
          Create customer user
        </Link>
      </section>
    </div>
  );
}
