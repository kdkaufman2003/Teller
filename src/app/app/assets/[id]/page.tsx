import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { buildAssetDepreciationSchedule } from "@/lib/accounting/fixed-asset-depreciation";
import { loadFixedAsset, sumPostedDepreciationForAsset } from "@/lib/accounting/fixed-assets";
import { netBookValue } from "@/lib/accounting/fixed-asset-depreciation-calc";
import { asNumber, money } from "@/lib/format";
import { routes } from "@/lib/routes";
import { getSessionContext, hasModule } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { StatusBadge } from "@/components/StatusBadge";
import { AssetActivatePanel } from "@/components/AssetActivatePanel";
import { AssetDisposePanel } from "@/components/AssetDisposePanel";

type Params = { params: Promise<{ id: string }> };

export default async function AssetDetailPage({ params }: Params) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  if (!hasModule(session.settings, "fixed_assets")) redirect(routes.app);

  const { id } = await params;
  const supabase = await createClient();
  const organizationId = session.organization.id;

  let asset;
  try {
    asset = await loadFixedAsset(supabase, organizationId, id);
  } catch {
    notFound();
  }

  const schedule = await buildAssetDepreciationSchedule(supabase, organizationId, id);
  const accum = await sumPostedDepreciationForAsset(supabase, id);
  const nbv = netBookValue(asNumber(asset.original_cost), accum);

  const { data: deprEntries } = await supabase
    .from("teller_fixed_asset_depreciation_entries")
    .select("period_year, period_month, amount, status, journal_entry_id")
    .eq("asset_id", id)
    .order("period_year")
    .order("period_month");

  return (
    <div className="space-y-6">
      <header className="page-header flex items-center justify-between gap-4">
        <div>
          <p className="text-muted text-sm">
            <Link href={routes.assets} className="hover:text-sky">
              Fixed assets
            </Link>
          </p>
          <h1>
            {asset.asset_number} · {asset.name}
          </h1>
        </div>
        <StatusBadge status={asset.status} />
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="card p-4">
          <p className="text-muted text-xs uppercase tracking-wide">Original cost</p>
          <p className="font-tabular text-xl">{money(asset.original_cost)}</p>
        </div>
        <div className="card p-4">
          <p className="text-muted text-xs uppercase tracking-wide">Accumulated depreciation</p>
          <p className="font-tabular text-xl">{money(accum)}</p>
        </div>
        <div className="card p-4">
          <p className="text-muted text-xs uppercase tracking-wide">Net book value</p>
          <p className="font-tabular text-xl">{money(nbv)}</p>
        </div>
      </div>

      {asset.status === "draft" ? <AssetActivatePanel asset={asset} /> : null}
      {asset.status === "active" ? <AssetDisposePanel asset={asset} /> : null}

      <div className="card overflow-hidden">
        <div className="border-b px-4 py-3 font-medium">Depreciation schedule</div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Period</th>
              <th className="text-right">Amount</th>
              <th className="text-right">Ending NBV</th>
              <th>Posted</th>
            </tr>
          </thead>
          <tbody>
            {schedule.map((line) => {
              const posted = (deprEntries ?? []).find(
                (entry) =>
                  entry.period_year === line.periodYear &&
                  entry.period_month === line.periodMonth &&
                  entry.status === "posted",
              );
              return (
                <tr key={`${line.periodYear}-${line.periodMonth}`}>
                  <td>
                    {line.periodYear}-{String(line.periodMonth).padStart(2, "0")}
                  </td>
                  <td className="text-right font-tabular">{money(line.depreciationAmount)}</td>
                  <td className="text-right font-tabular">{money(line.endingBookValue)}</td>
                  <td>{posted ? "Yes" : "No"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
