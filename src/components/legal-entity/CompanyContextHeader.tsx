import Link from "next/link";
import { routes } from "@/lib/routes";
import { companyBooksLabel } from "@/lib/legal-entity/ux";
import type { ActiveLegalEntitySummary } from "@/types";

type Scope = "company" | "consolidated" | "all_companies";

export function CompanyContextHeader({
  activeLegalEntity,
  scope = "company",
  subtitle,
  consolidatedLabel,
  showAllCompaniesLink = false,
}: {
  activeLegalEntity?: ActiveLegalEntitySummary | null;
  scope?: Scope;
  subtitle?: string;
  consolidatedLabel?: string;
  showAllCompaniesLink?: boolean;
}) {
  if (scope === "consolidated") {
    return (
      <div className="mb-4 rounded-lg border border-rule bg-white/60 px-4 py-3">
        <p className="text-[11px] uppercase tracking-[0.14em] text-muted">Consolidated reports</p>
        <p className="font-medium text-navy">{consolidatedLabel ?? "All Companies"}</p>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
      </div>
    );
  }

  if (scope === "all_companies") {
    return (
      <div className="mb-4 rounded-lg border border-rule bg-white/60 px-4 py-3">
        <p className="text-[11px] uppercase tracking-[0.14em] text-muted">All Companies overview</p>
        <p className="font-medium text-navy">Comparison across your companies</p>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
      </div>
    );
  }

  if (!activeLegalEntity) return null;

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rule bg-white/60 px-4 py-3">
      <div>
        <p className="text-[11px] uppercase tracking-[0.14em] text-muted">Current company</p>
        <p className="font-medium text-navy">
          {companyBooksLabel(activeLegalEntity.name, activeLegalEntity.entityCode)}
        </p>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {showAllCompaniesLink ? (
        <Link href={routes.companiesOverview} className="text-sm text-sky hover:underline">
          All Companies →
        </Link>
      ) : null}
    </div>
  );
}
