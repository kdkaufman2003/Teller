import Link from "next/link";

export default function OpsHomePage() {
  return (
    <div className="space-y-6">
      <header className="page-header">
        <h1>Operator console</h1>
        <p>Create customer logins and provision new organizations.</p>
      </header>

      <section className="card p-4">
        <h2 className="font-medium">Users & credentials</h2>
        <p className="text-muted mb-3 text-sm">
          Create a Supabase auth user with a temporary password, attach them to an org, and send a
          password email.
        </p>
        <Link href="/ops/users/new" className="btn btn-primary">
          Create user
        </Link>
      </section>
    </div>
  );
}
