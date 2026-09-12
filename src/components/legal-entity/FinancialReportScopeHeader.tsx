import { companyBooksLabel } from "@/lib/legal-entity/ux";

type Scope = "company" | "consolidated";

export function FinancialReportScopeHeader({
  scope = "company",
  companyName,
  entityCode,
  reportName,
  periodLabel,
  eliminationMode,
  consolidatedLabel,
}: {
  scope?: Scope;
  companyName?: string;
  entityCode?: string | null;
  reportName: string;
  periodLabel: string;
  eliminationMode?: "pre" | "post";
  consolidatedLabel?: string;
}) {
  const scopeLabel =
    scope === "consolidated"
      ? consolidatedLabel ?? "All Companies"
      : companyName
        ? companyBooksLabel(companyName, entityCode)
        : "Current company";

  return (
    <div className="rounded-lg border border-rule bg-white/60 px-4 py-3">
      <p className="text-[11px] uppercase tracking-[0.14em] text-muted">
        {scope === "consolidated" ? "Consolidated report" : "Company report"}
      </p>
      <p className="font-medium text-navy">{scopeLabel}</p>
      <p className="mt-1 font-ledger text-xl text-navy">{reportName}</p>
      <p className="mt-1 text-sm text-muted">{periodLabel}</p>
      {eliminationMode ? (
        <p className="mt-1 text-xs text-muted">
          {eliminationMode === "post" ? "Post-elimination" : "Pre-elimination"}
        </p>
      ) : null}
    </div>
  );
}
