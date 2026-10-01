import Link from "next/link";
import { redirect } from "next/navigation";
import { isPlatformAdmin } from "@/lib/platform/auth";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";

export default async function OpsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionContext();
  if (!session) redirect(`${routes.login}?next=/ops`);

  const admin = await isPlatformAdmin();
  if (!admin) {
    return (
      <div className="mx-auto max-w-lg px-6 py-16">
        <h1 className="text-xl font-semibold">Access denied</h1>
        <p className="text-muted mt-2 text-sm">
          This area is for Teller platform operators only.
        </p>
        <Link href={routes.app} className="btn btn-secondary mt-4 inline-flex">
          Back to books
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-paper">
      <header className="border-b border-border bg-white px-6 py-4">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
          <div>
            <p className="text-muted text-xs uppercase tracking-wide">Platform</p>
            <h1 className="text-lg font-semibold">Teller operator</h1>
          </div>
          <nav className="flex gap-3 text-sm">
            <Link href="/ops" className="hover:underline">
              Home
            </Link>
            <Link href="/ops/users/new" className="hover:underline">
              Create user
            </Link>
            <Link href={routes.app} className="hover:underline">
              Books
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-8">{children}</main>
    </div>
  );
}
