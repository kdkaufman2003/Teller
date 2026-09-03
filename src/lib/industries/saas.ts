import type { AccountSeed } from "@/types";
import type { IndustryAnswers, IndustryPack } from "./types";
import { CORE_MODULES } from "./types";

const SAAS_ACCOUNTS: AccountSeed[] = [
  { code: "1000", name: "Cash", type: "asset", subtype: "bank" },
  { code: "1100", name: "Accounts Receivable", type: "asset", subtype: "receivable" },
  { code: "2000", name: "Accounts Payable", type: "liability", subtype: "payable" },
  { code: "2100", name: "Deferred Revenue", type: "liability", subtype: "deferred", industry_tag: "deferred" },
  { code: "2200", name: "Sales Tax Payable", type: "liability", subtype: "tax", industry_tag: "tax" },
  { code: "3000", name: "Owner's Equity", type: "equity" },
  { code: "3100", name: "Retained Earnings", type: "equity" },
  { code: "4000", name: "Subscription Revenue", type: "revenue", industry_tag: "subscription" },
  { code: "4100", name: "Usage Revenue", type: "revenue", industry_tag: "usage" },
  { code: "4200", name: "Services Revenue", type: "revenue", industry_tag: "services" },
  { code: "5000", name: "Hosting & Infrastructure", type: "cogs" },
  { code: "5100", name: "Payment Processing", type: "cogs" },
  { code: "6000", name: "Payroll", type: "expense" },
  { code: "6100", name: "Software & Tools", type: "expense" },
  { code: "6200", name: "Marketing", type: "expense" },
  { code: "6300", name: "Office", type: "expense" },
  { code: "6900", name: "Other Expense", type: "expense" },
];

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value) return [value];
  return [];
}

function isOn(value: unknown): boolean {
  return value === true || value === "true" || value === "yes";
}

export const saasPack: IndustryPack = {
  id: "saas",
  name: "SaaS",
  shortName: "SaaS",
  tagline: "Subscriptions, deferred revenue, and MRR",
  description:
    "For software companies. Tracks subscription vs usage revenue and can hold prepaid terms as deferred revenue.",
  questions: [
    {
      id: "billingModel",
      prompt: "How do customers pay?",
      type: "select",
      default: "subscription",
      options: [
        { value: "subscription", label: "Recurring subscriptions" },
        { value: "usage", label: "Usage / metered" },
        { value: "hybrid", label: "Subscription + usage" },
      ],
    },
    {
      id: "customerNoun",
      prompt: "What should we call the people you bill?",
      type: "select",
      default: "customers",
      options: [
        { value: "customers", label: "Customers" },
        { value: "accounts", label: "Accounts" },
        { value: "tenants", label: "Tenants" },
      ],
    },
    {
      id: "recognition",
      prompt: "When should subscription revenue hit the P&L?",
      type: "select",
      default: "deferred",
      options: [
        {
          value: "deferred",
          label: "Over the term (deferred revenue — recommended)",
        },
        { value: "immediate", label: "When the invoice is sent" },
      ],
    },
    {
      id: "trackMrr",
      prompt: "Show MRR / ARR on the dashboard?",
      type: "boolean",
      default: true,
    },
    {
      id: "revenueStreams",
      prompt: "Which revenue accounts do you need?",
      type: "multiselect",
      default: ["subscription", "services"],
      options: [
        { value: "subscription", label: "Subscription" },
        { value: "usage", label: "Usage" },
        { value: "services", label: "Implementation / services" },
      ],
    },
    {
      id: "collectTax",
      prompt: "Collect sales tax?",
      type: "boolean",
      default: false,
    },
    {
      id: "basis",
      prompt: "Accounting basis",
      type: "select",
      default: "accrual",
      options: [
        { value: "accrual", label: "Accrual" },
        { value: "cash", label: "Cash" },
      ],
    },
    {
      id: "fiscalYearStart",
      prompt: "Fiscal year start",
      type: "select",
      default: "1",
      options: [
        { value: "1", label: "January" },
        { value: "4", label: "April" },
        { value: "7", label: "July" },
        { value: "10", label: "October" },
      ],
    },
  ],
  resolve(answers: IndustryAnswers) {
    const streams = asList(answers.revenueStreams);
    const modules: string[] = [...CORE_MODULES];
    if (isOn(answers.trackMrr)) modules.push("mrr");
    if (answers.recognition === "deferred") modules.push("deferred-revenue");

    const customerNoun = String(answers.customerNoun || "customers");
    const customerLabel =
      customerNoun.charAt(0).toUpperCase() + customerNoun.slice(1);

    const tagsToKeep = new Set<string>(["", ...streams]);
    if (answers.recognition === "deferred") tagsToKeep.add("deferred");
    if (isOn(answers.collectTax)) tagsToKeep.add("tax");

    const accounts = SAAS_ACCOUNTS.filter((account) => {
      const tag = account.industry_tag || "";
      return !tag || tagsToKeep.has(tag);
    });

    return {
      modules,
      labels: {
        customer: customerLabel,
        customerSingular: customerLabel.replace(/s$/, "") || "Customer",
        job: "Projects",
        jobSingular: "Project",
        invoice: "Invoices",
      },
      accounts,
    };
  },
};
