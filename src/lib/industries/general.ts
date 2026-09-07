import type { AccountSeed } from "@/types";
import type { IndustryAnswers, IndustryPack } from "./types";
import { CORE_MODULES } from "./types";
import {
  formatCustomerLabels,
  GENERAL_CUSTOMER_NOUN_OPTIONS,
} from "./customer-labels";
import { accountingBasisQuestion } from "./accounting-basis";
import { DEFAULT_FIXED_ASSET_ACCOUNT_SEEDS } from "@/lib/accounting/fixed-asset-accounts";

const GENERAL_ACCOUNTS: AccountSeed[] = [
  { code: "1000", name: "Cash", type: "asset", subtype: "bank" },
  { code: "1100", name: "Accounts Receivable", type: "asset", subtype: "receivable" },
  { code: "1200", name: "Inventory", type: "asset", subtype: "inventory", industry_tag: "inventory" },
  ...DEFAULT_FIXED_ASSET_ACCOUNT_SEEDS,
  { code: "1300", name: "Prepaid Expenses", type: "asset", subtype: "prepaid" },
  { code: "1350", name: "Accrued Receivable", type: "asset", subtype: "accrued_receivable" },
  { code: "2000", name: "Accounts Payable", type: "liability", subtype: "payable" },
  { code: "2050", name: "Accrued Liabilities", type: "liability", subtype: "accrued_liability" },
  { code: "2100", name: "Sales Tax Payable", type: "liability", subtype: "tax", industry_tag: "tax" },
  { code: "3000", name: "Owner's Equity", type: "equity" },
  { code: "3100", name: "Retained Earnings", type: "equity", subtype: "retained_earnings" },
  { code: "4000", name: "Sales", type: "revenue" },
  { code: "4100", name: "Service Revenue", type: "revenue" },
  { code: "5000", name: "Cost of Goods Sold", type: "cogs", industry_tag: "inventory" },
  { code: "6000", name: "Payroll", type: "expense" },
  { code: "6100", name: "Rent", type: "expense" },
  { code: "6200", name: "Marketing", type: "expense" },
  { code: "6300", name: "Office", type: "expense" },
  { code: "6150", name: "Payment Processing Fees", type: "expense", subtype: "payment_fee" },
  { code: "6900", name: "Other Expense", type: "expense" },
];

function isOn(value: unknown): boolean {
  return value === true || value === "true" || value === "yes";
}

export const generalPack: IndustryPack = {
  id: "general",
  name: "General business",
  shortName: "General",
  tagline: "A clean chart of accounts you can grow into",
  description:
    "Start here if you are not HVAC or SaaS yet. You can add industry modules later.",
  questions: [
    {
      id: "customerNoun",
      prompt: "What should we call the people you bill?",
      type: "select",
      section: "business",
      default: "customers",
      options: GENERAL_CUSTOMER_NOUN_OPTIONS,
    },
    accountingBasisQuestion(),
    {
      id: "trackJobs",
      prompt: "Track jobs or projects?",
      type: "boolean",
      section: "operations",
      default: false,
    },
    {
      id: "trackFixedAssets",
      prompt: "Track fixed assets and depreciation?",
      type: "boolean",
      section: "operations",
      default: false,
    },
    {
      id: "trackInventory",
      prompt: "Track inventory?",
      type: "boolean",
      section: "operations",
      default: false,
    },
    {
      id: "collectTax",
      prompt: "Collect sales tax?",
      type: "boolean",
      section: "accounting",
      default: false,
    },
    {
      id: "taxRate",
      prompt: "Default sales tax rate (%)",
      type: "number",
      section: "accounting",
      default: 0,
    },
    {
      id: "fiscalYearStart",
      prompt: "Fiscal year start",
      type: "select",
      section: "accounting",
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
    const modules: string[] = [...CORE_MODULES];
    if (isOn(answers.trackJobs)) modules.push("jobs");
    if (isOn(answers.trackFixedAssets)) modules.push("fixed_assets");
    if (isOn(answers.trackInventory)) modules.push("inventory");

    const { customer: customerLabel, customerSingular } = formatCustomerLabels(
      String(answers.customerNoun || "customers"),
    );

    const tagsToKeep = new Set<string>([""]);
    if (isOn(answers.trackInventory)) tagsToKeep.add("inventory");
    if (isOn(answers.collectTax)) tagsToKeep.add("tax");

    const accounts = GENERAL_ACCOUNTS.filter((account) => {
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
