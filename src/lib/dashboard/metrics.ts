import { isTradesIndustryId } from "@/lib/industries/registry";
import type { TellerSettings } from "@/types";

export type DashboardMetric = {
  key: string;
  label: string;
  hint?: string;
};

export function dashboardMetricsForIndustry(
  industryId: string | null | undefined,
  settings: TellerSettings | null | undefined,
): DashboardMetric[] {
  const trades = isTradesIndustryId(industryId);
  const customer = settings?.labels?.customerSingular ?? "Customer";
  const jobLabel = settings?.labels?.job ?? "Jobs";
  const hasJobs = settings?.modules?.includes("jobs");

  if (trades && hasJobs) {
    return [
      {
        key: "openAR",
        label: "Awaiting payment",
        hint: "Invoiced work not yet collected",
      },
      {
        key: "collected",
        label: "Collected on jobs",
        hint: "Customer payments received",
      },
      {
        key: "openAP",
        label: "Vendor bills due",
        hint: "Expenses not yet paid",
      },
      {
        key: "activeJobs",
        label: `Active ${jobLabel.toLowerCase()}`,
        hint: "Scheduled or in-progress work",
      },
    ];
  }

  return [
    {
      key: "openAR",
      label: "Open receivables",
      hint: `${customer}s with unpaid invoices`,
    },
    {
      key: "collected",
      label: "Collected",
      hint: "Paid invoice totals",
    },
    {
      key: "openAP",
      label: "Open payables",
      hint: "Unpaid expenses",
    },
  ];
}
