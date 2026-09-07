import Link from "next/link";
import { redirect } from "next/navigation";
import { buildFixedAssetRegister } from "@/lib/accounting/fixed-asset-register";
import { money } from "@/lib/format";
import { assetPath, routes } from "@/lib/routes";
import { getSessionContext, hasModule } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { StatusBadge } from "@/components/StatusBadge";

export default async function AssetsPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  if (!hasModule(session.settings, "fixed_assets")) redirect(routes.app);

  const supabase = await createClient();
  const register = await buildFixedAssetRegister(supabase, session.organization.id);

  const { data: categories } = await supabase
    .from("teller_fixed_asset_categories")
    .select("id, name")
    .eq("organization_id", session.organization.id);
  const categoryNames = new Map((categories ?? []).map((row) => [row.id as string, row.name as string]));

  return (
    <div className="space-y-6">
      <header className="page-header flex items-center justify-between gap-4">
        <h1>Fixed assets</h1>
        <div className="flex gap-2">
          <Link href={routes.assetsReconciliation} className="btn btn-secondary">
            Reconciliation
          </Link>
          <Link href={routes.assetsDepreciation} className="btn btn-secondary">
            Depreciation
          </Link>
          <Link href={routes.assetNew} className="btn btn-primary">
            New asset
          </Link>
        </div>
      </header>
      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Asset #</th>
              <th>Name</th>
              <th>Category</th>
              <th>Status</th>
              <th className="text-right">Cost</th>
              <th className="text-right">Accum depr</th>
              <th className="text-right">NBV</th>
            </tr>
          </thead>
          <tbody>
            {register.map((asset) => (
              <tr key={asset.id}>
                <td>
                  <Link href={assetPath(asset.id)} className="font-medium hover:text-sky">
                    {asset.asset_number}
                  </Link>
                </td>
                <td>{asset.name}</td>
                <td>{asset.category_id ? categoryNames.get(asset.category_id) : "—"}</td>
                <td>
                  <StatusBadge status={asset.status} />
                  {asset.isFullyDepreciated && asset.status === "active" ? (
                    <span className="text-muted ml-2 text-xs">fully depreciated</span>
                  ) : null}
                </td>
                <td className="text-right font-tabular">{money(asset.original_cost)}</td>
                <td className="text-right font-tabular">{money(asset.accumulatedDepreciation)}</td>
                <td className="text-right font-tabular">{money(asset.netBookValue)}</td>
              </tr>
            ))}
            {!register.length ? (
              <tr>
                <td colSpan={7} className="text-muted py-8 text-center">
                  No fixed assets yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
