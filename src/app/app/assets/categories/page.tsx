import { redirect } from "next/navigation";
import { listFixedAssetCategories } from "@/lib/accounting/fixed-asset-settings";
import { routes } from "@/lib/routes";
import { getSessionContext, hasModule } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export default async function AssetCategoriesPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  if (!hasModule(session.settings, "fixed_assets")) redirect(routes.app);

  const supabase = await createClient();
  const categories = await listFixedAssetCategories(supabase, session.organization.id);

  return (
    <div className="space-y-6">
      <header className="page-header">
        <h1>Fixed asset categories</h1>
      </header>
      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th className="text-right">Useful life (months)</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((category) => (
              <tr key={category.id as string}>
                <td>{category.code as string}</td>
                <td>{category.name as string}</td>
                <td className="text-right">{category.default_useful_life_months as number}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
