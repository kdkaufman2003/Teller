import { redirect } from "next/navigation";
import Link from "next/link";
import { ReconciliationSetupForm } from "@/components/banking/reconciliation/ReconciliationSetupForm";
import { canWriteBooks } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/session";
import { routes } from "@/lib/routes";

export default async function NewReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<{ bankAccountId?: string }>;
}) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const { bankAccountId } = await searchParams;
  if (!bankAccountId) redirect(routes.bankingReconcile);

  const supabase = await createClient();
  const { data: account } = await supabase
    .from("teller_bank_accounts")
    .select("id, name")
    .eq("organization_id", session.organization.id)
    .eq("id", bankAccountId)
    .maybeSingle();

  if (!account) redirect(routes.bankingReconcile);

  const canWrite = canWriteBooks(session.profile?.role);

  return (
    <>
      <header className="page-header">
        <h1>Start reconciliation</h1>
        <p>Enter your statement ending date and balance</p>
      </header>
      <ReconciliationSetupForm
        bankAccountId={account.id}
        accountName={account.name}
        canWrite={canWrite}
      />
      <Link href={routes.bankingReconcile} className="mt-4 inline-block text-sm text-sky">
        Back to accounts
      </Link>
    </>
  );
}
