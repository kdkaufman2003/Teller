import type { CashFlowLine } from "./types";

export type CashSourceCoverageItem = {
  key: string;
  label: string;
  included: boolean;
  count: number;
};

export function buildSourceCoverage(lines: CashFlowLine[]): CashSourceCoverageItem[] {
  const counts = {
    ar: 0,
    ap: 0,
    payroll: 0,
    recurring: 0,
    purchasing: 0,
    capex: 0,
    manual: 0,
  };

  for (const line of lines) {
    switch (line.category) {
      case "ar_collection":
        counts.ar += 1;
        break;
      case "ap_payment":
        counts.ap += 1;
        break;
      case "payroll":
        counts.payroll += 1;
        break;
      case "recurring":
        counts.recurring += 1;
        break;
      case "purchasing":
        counts.purchasing += 1;
        break;
      case "capex":
        counts.capex += 1;
        break;
      case "manual":
        counts.manual += 1;
        break;
      default:
        break;
    }
  }

  return [
    { key: "receivables", label: "Receivables", included: true, count: counts.ar },
    { key: "payables", label: "Payables", included: true, count: counts.ap },
    { key: "payroll", label: "Payroll", included: true, count: counts.payroll },
    { key: "recurring", label: "Recurring Bills", included: true, count: counts.recurring },
    { key: "purchasing", label: "Purchasing Commitments", included: true, count: counts.purchasing },
    { key: "capex", label: "Planned Capex", included: true, count: counts.capex },
    { key: "manual", label: "Manual Adjustments", included: true, count: counts.manual },
  ];
}

export const CATEGORY_OWNER_LABELS: Record<string, string> = {
  ar_collection: "Receivables",
  ap_payment: "Payables",
  payroll: "Payroll",
  recurring: "Recurring Bills",
  purchasing: "Purchasing",
  capex: "Planned Equipment / Capex",
  manual: "Manual Adjustments",
};
