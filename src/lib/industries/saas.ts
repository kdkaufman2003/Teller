import type { AccountSeed } from "@/types";
import type { IndustryAnswers, IndustryPack } from "./types";
import { CORE_MODULES } from "./types";
import {
  formatCustomerLabels,
  SAAS_CUSTOMER_NOUN_OPTIONS,
} from "./customer-labels";
import { accountingBasisQuestion } from "./accounting-basis";
import { DEFAULT_FIXED_ASSET_ACCOUNT_SEEDS } from "@/lib/accounting/fixed-asset-accounts";

const SAAS_ACCOUNTS: AccountSeed[] = [
  { code: "1000", name: "Cash", type: "asset", subtype: "bank" },
  { code: "1100", name: "Accounts Receivable", type: "asset", subtype: "receivable" },
  ...DEFAULT_FIXED_ASSET_ACCOUNT_SEEDS,
  { code: "1300", name: "Prepaid Expenses", type: "asset", subtype: "prepaid" },
  { code: "1350", name: "Accrued Receivable", type: "asset", subtype: "accrued_receivable" },
  { code: "2000", name: "Accounts Payable", type: "liability", subtype: "payable" },
  { code: "2050", name: "Accrued Liabilities", type: "liability", subtype: "accrued_liability" },
  { code: "2100", name: "Deferred Revenue", type: "liability", subtype: "deferred", industry_tag: "deferred" },
  { code: "2200", name: "Sales Tax Payable", type: "liability", subtype: "tax", industry_tag: "tax" },
  { code: "3000", name: "Owner's Equity", type: "equity" },
  { code: "3100", name: "Retained Earnings", type: "equity", subtype: "retained_earnings" },
  { code: "4000", name: "Subscription Revenue", type: "revenue", industry_tag: "subscription" },
  { code: "4100", name: "Usage Revenue", type: "revenue", industry_tag: "usage" },
  { code: "4200", name: "Services Revenue", type: "revenue", industry_tag: "services" },
  { code: "5000", name: "Hosting & Infrastructure", type: "cogs" },
  { code: "5100", name: "Payment Processing", type: "cogs", subtype: "payment_fee" },
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
      options: SAAS_CUSTOMER_NOUN_OPTIONS,
    },
    {
      id: "recognition",
      prompt: "When should subscription revenue hit the P&L?",
      help: "If customers prepay for annual or quarterly plans, this controls whether revenue is spread over the subscription period or booked all at once.",
      type: "select",
      default: "deferred",
      options: [
        {
          value: "deferred",
          label: "Over the term (recommended)",
          description:
            "Revenue is recognized a little each month as you deliver the service. Example: a $1,200 annual payment becomes $100/month on the P&L; the rest stays in Deferred Revenue until earned. This matches how most SaaS companies report on accrual books.",
        },
        {
          value: "immediate",
          label: "When the invoice is sent",
          description:
            "The full invoice amount hits revenue the day you bill, even if the customer prepaid for a longer term. Simpler to track, but monthly P&L can look higher than the value you've actually delivered so far.",
        },
      ],
    },
    {
      id: "trackMrr",
      prompt: "Show MRR / ARR on the dashboard?",
      help: "MRR (Monthly Recurring Revenue) is your subscription income normalized to a monthly figure — e.g. one customer on a $1,200/year plan counts as $100/mo. ARR is that number × 12. These metrics sit alongside your P&L so you can track recurring growth, not just cash collected or invoices sent.",
      type: "boolean",
      default: true,
    },
    {
      id: "revenueStreams",
      prompt: "Which revenue accounts do you need?",
      help: "Teller creates a separate income account for each type you select, so subscription income stays separate from one-time work on your P&L.",
      type: "multiselect",
      default: ["subscription", "services"],
      options: [
        {
          value: "subscription",
          label: "Subscription",
          description: "Recurring software fees — monthly or annual plans.",
        },
        {
          value: "usage",
          label: "Usage",
          description: "Metered or pay-as-you-go charges — API calls, seats, storage, etc.",
        },
        {
          value: "services",
          label: "Implementation / services",
          description:
            "One-time professional work: onboarding, setup, data migration, training, custom integrations, or project-based consulting.",
        },
      ],
    },
    {
      id: "collectTax",
      prompt: "Collect sales tax?",
      type: "boolean",
      default: false,
    },
    accountingBasisQuestion(),
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
    if (isOn(answers.trackFixedAssets)) modules.push("fixed_assets");
    if (answers.recognition === "deferred") modules.push("deferred-revenue");

    const { customer: customerLabel, customerSingular } = formatCustomerLabels(
      String(answers.customerNoun || "customers"),
    );

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
        customerSingular,
        job: "Projects",
        jobSingular: "Project",
        invoice: "Invoices",
      },
      accounts,
    };
  },
};
