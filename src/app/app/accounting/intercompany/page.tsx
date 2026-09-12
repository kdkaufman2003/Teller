import Link from "next/link";
import { IntercompanyPanel } from "@/components/intercompany/IntercompanyPanel";
import { listIntercompanyTransactions } from "@/lib/accounting/intercompany";
import { canWriteBooks } from "@/lib/auth/roles";
import { resolveLegalEntityId } from "@/lib/accounting/post";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { routes } from "@/lib/routes";
import { redirect } from "next/navigation";

export default async function IntercompanyPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const supabase = await createClient();
  const organizationId = session.organization.id;
  const role = session.profile?.role ?? "viewer";
  const legalEntityId = await resolveLegalEntityId(
    supabase,
    organizationId,
    session.profile?.active_legal_entity_id ?? null,
  );

  const [{ data: entities }, { data: accounts }] = await Promise.all([
    supabase
      .from("teller_legal_entities")
      .select("id, name, entity_code")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("teller_accounts")
      .select("id, code, name, type, subtype, legal_entity_id")
      .eq("organization_id", organizationId)
      .order("code"),
  ]);

  let initialTransactions: Awaited<ReturnType<typeof listIntercompanyTransactions>> = [];
  try {
    initialTransactions = await listIntercompanyTransactions(supabase, {
      organizationId,
      legalEntityId,
      limit: 50,
    });
  } catch {
    initialTransactions = [];
  }

  const accountsByEntity: Record<string, Array<{ id: string; code: string; name: string }>> = {};
  for (const account of accounts ?? []) {
    const bucket = accountsByEntity[account.legal_entity_id] ?? [];
    bucket.push({ id: account.id, code: account.code, name: account.name });
    accountsByEntity[account.legal_entity_id] = bucket;
  }

  return (
    <div className="space-y-6">
      <header className="page-header">
        <Link href={routes.accounting} className="text-sm text-muted">
          ← Accounting
        </Link>
        <h1 className="mt-2">Between companies</h1>
        <p className="text-muted">
          Pay expenses, receive cash, or transfer money between companies in your organization. Each company gets its own balanced journal entry.
        </p>
      </header>

      <IntercompanyPanel
        entities={(entities ?? []).map((e) => ({
          id: e.id,
          name: e.name,
          entityCode: e.entity_code,
        }))}
        accountsByEntity={accountsByEntity}
        initialTransactions={initialTransactions as never[]}
        canWrite={canWriteBooks(role)}
      />
    </div>
  );
}
