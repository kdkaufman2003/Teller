/** Organization provisioning source — drives default modules and integrations. */
export type OrganizationSource = "direct" | "hfac" | "partner";

export type OrgAccountingConfig = {
  basis: "cash" | "accrual";
  fiscalYearStart: number;
  taxRate: number;
  collectTax: boolean;
};

const FISCAL_MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function parseFiscalYearStart(value: unknown): number {
  const month = Number(value);
  if (month >= 1 && month <= 12) return month;
  return 1;
}

export function fiscalYearStartLabel(month: number): string {
  return FISCAL_MONTH_LABELS[parseFiscalYearStart(month) - 1] ?? "January";
}

export function collectTaxEnabled(answers: Record<string, unknown> | null | undefined): boolean {
  if (!answers) return false;
  const collect = answers.collectTax;
  if (collect === false || collect === "false" || collect === "no") return false;
  if (collect === true || collect === "true" || collect === "yes") return true;
  return Number(answers.taxRate || 0) > 0;
}

export function resolveOrgTaxRate(answers: Record<string, unknown> | null | undefined): number {
  if (!collectTaxEnabled(answers)) return 0;
  return Math.max(0, Number(answers?.taxRate || 0));
}

export function parseAccountingBasis(value: unknown): "cash" | "accrual" {
  return value === "cash" ? "cash" : "accrual";
}

export function readOrgAccountingConfig(
  answers: Record<string, unknown> | null | undefined,
): OrgAccountingConfig {
  return {
    basis: parseAccountingBasis(answers?.basis),
    fiscalYearStart: parseFiscalYearStart(answers?.fiscalYearStart),
    taxRate: resolveOrgTaxRate(answers),
    collectTax: collectTaxEnabled(answers),
  };
}

export function organizationSourceFromPartner(partnerId: string | null): OrganizationSource {
  if (partnerId === "hasslefreeac") return "hfac";
  if (partnerId) return "partner";
  return "direct";
}

/** Start of the fiscal year containing `today`. */
export function fiscalYearStartDate(today: Date, fiscalYearStartMonth: number): Date {
  const month = today.getMonth() + 1;
  const fyStart = parseFiscalYearStart(fiscalYearStartMonth);
  const year = month >= fyStart ? today.getFullYear() : today.getFullYear() - 1;
  return new Date(year, fyStart - 1, 1);
}

/** Fiscal quarter index (0–3) within the current fiscal year. */
export function fiscalQuarterIndex(today: Date, fiscalYearStartMonth: number): number {
  const fyStart = fiscalYearStartDate(today, fiscalYearStartMonth);
  const monthsSince =
    (today.getFullYear() - fyStart.getFullYear()) * 12 +
    (today.getMonth() - fyStart.getMonth());
  return Math.floor(monthsSince / 3);
}

export function fiscalQuarterStartDate(today: Date, fiscalYearStartMonth: number): Date {
  const fyStart = fiscalYearStartDate(today, fiscalYearStartMonth);
  const quarter = fiscalQuarterIndex(today, fiscalYearStartMonth);
  return new Date(fyStart.getFullYear(), fyStart.getMonth() + quarter * 3, 1);
}
