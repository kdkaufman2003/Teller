import { BudgetEditor } from "@/components/planning/BudgetEditor";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { routes } from "@/lib/routes";
import { redirect } from "next/navigation";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ version?: string }>;
};

export default async function BudgetDetailPage({ params, searchParams }: PageProps) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const { id } = await params;
  const { version: versionQuery } = await searchParams;
  const supabase = await createClient();

  const { data: budget, error } = await supabase
    .from("teller_budgets")
    .select("*")
    .eq("organization_id", session.organization.id)
    .eq("id", id)
    .maybeSingle();

  if (error || !budget) {
    return (
      <div className="p-6">
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
          {error?.message?.match(/does not exist|schema cache/i)
            ? "Apply migration 032 to view this budget."
            : "Budget not found."}
        </p>
      </div>
    );
  }

  const { data: versions } = await supabase
    .from("teller_budget_versions")
    .select("id, version_number, label, status")
    .eq("organization_id", session.organization.id)
    .eq("budget_id", id)
    .order("version_number", { ascending: false });

  const versionList = versions ?? [];
  const initialVersionId =
    versionQuery && versionList.some((v) => v.id === versionQuery)
      ? versionQuery
      : versionList[0]?.id;

  return (
    <div className="p-6">
      <BudgetEditor
        budgetId={budget.id as string}
        budgetName={budget.name as string}
        fiscalYear={Number(budget.fiscal_year)}
        versions={versionList as { id: string; version_number: number; label: string; status: string }[]}
        initialVersionId={initialVersionId}
      />
    </div>
  );
}
