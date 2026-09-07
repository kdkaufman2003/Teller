import type { AccountSeed } from "@/types";
import type { IndustryAnswers, IndustryPack, IndustryQuestion } from "./types";
import { CORE_MODULES } from "./types";
import {
  formatCustomerLabels,
  TRADES_CUSTOMER_NOUN_OPTIONS,
} from "./customer-labels";
import { accountingBasisQuestion } from "./accounting-basis";
import { DEFAULT_FIXED_ASSET_ACCOUNT_SEEDS } from "@/lib/accounting/fixed-asset-accounts";

export const TRADES_ACCOUNTS: AccountSeed[] = [
  { code: "1000", name: "Cash", type: "asset", subtype: "bank" },
  { code: "1100", name: "Accounts Receivable", type: "asset", subtype: "receivable" },
  { code: "1200", name: "Inventory — Equipment", type: "asset", subtype: "inventory", industry_tag: "inventory" },
  { code: "1210", name: "Inventory — Parts", type: "asset", subtype: "inventory", industry_tag: "inventory" },
  ...DEFAULT_FIXED_ASSET_ACCOUNT_SEEDS,
  { code: "1300", name: "Prepaid Expenses", type: "asset", subtype: "prepaid" },
  { code: "1350", name: "Accrued Receivable", type: "asset", subtype: "accrued_receivable" },
  { code: "2000", name: "Accounts Payable", type: "liability", subtype: "payable" },
  { code: "2050", name: "Accrued Liabilities", type: "liability", subtype: "accrued_liability" },
  { code: "2100", name: "Sales Tax Payable", type: "liability", subtype: "tax", industry_tag: "tax" },
  { code: "2200", name: "Warranty Reserve", type: "liability", subtype: "reserve", industry_tag: "warranty" },
  { code: "2300", name: "Customer Deposits", type: "liability", subtype: "deposit" },
  { code: "3000", name: "Owner's Equity", type: "equity" },
  { code: "3100", name: "Retained Earnings", type: "equity", subtype: "retained_earnings" },
  { code: "4000", name: "Equipment Sales", type: "revenue", industry_tag: "equipment" },
  { code: "4015", name: "Residential HVAC Revenue", type: "revenue", industry_tag: "residential" },
  { code: "4025", name: "Commercial HVAC Revenue", type: "revenue", industry_tag: "commercial" },
  { code: "4100", name: "Installation Labor", type: "revenue", industry_tag: "labor" },
  { code: "4200", name: "Service & Repair", type: "revenue", industry_tag: "service" },
  { code: "4300", name: "Maintenance Agreements", type: "revenue", industry_tag: "maintenance" },
  { code: "4400", name: "Parts & Accessories", type: "revenue", industry_tag: "parts" },
  { code: "4500", name: "Warranty Revenue", type: "revenue", industry_tag: "warranty" },
  { code: "5000", name: "Equipment Cost", type: "cogs", industry_tag: "equipment" },
  { code: "5100", name: "Parts Cost", type: "cogs", industry_tag: "parts" },
  { code: "5200", name: "Subcontractor Cost", type: "cogs", industry_tag: "labor" },
  { code: "6000", name: "Payroll", type: "expense" },
  { code: "6100", name: "Vehicle & Fuel", type: "expense" },
  { code: "6200", name: "Tools & Supplies", type: "expense" },
  { code: "6300", name: "Rent", type: "expense" },
  { code: "6400", name: "Insurance", type: "expense" },
  { code: "6500", name: "Marketing", type: "expense" },
  { code: "6600", name: "Office", type: "expense" },
  { code: "6150", name: "Payment Processing Fees", type: "expense", subtype: "payment_fee" },
  { code: "6700", name: "Warranty Expense", type: "expense", industry_tag: "warranty" },
  { code: "6850", name: "Bad Debt Expense", type: "expense", subtype: "bad_debt" },
  { code: "6900", name: "Other Expense", type: "expense" },
];

export type TradesPackConfig = {
  id: string;
  name: string;
  shortName: string;
  tagline: string;
  description: string;
  category: string;
  tradeLabel: string;
  recommended?: boolean;
  answerDefaults?: IndustryAnswers;
  extraQuestions?: IndustryQuestion[];
};

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value) return [value];
  return [];
}

function isOn(value: unknown): boolean {
  return value === true || value === "true" || value === "yes";
}

const FISCAL_YEAR_QUESTION: IndustryQuestion = {
  id: "fiscalYearStart",
  prompt: "When does your fiscal year start?",
  type: "select",
  default: "1",
  options: [
    { value: "1", label: "January" },
    { value: "2", label: "February" },
    { value: "3", label: "March" },
    { value: "4", label: "April" },
    { value: "5", label: "May" },
    { value: "6", label: "June" },
    { value: "7", label: "July" },
    { value: "8", label: "August" },
    { value: "9", label: "September" },
    { value: "10", label: "October" },
    { value: "11", label: "November" },
    { value: "12", label: "December" },
  ],
};

function buildTradesQuestions(
  tradeLabel: string,
  defaults: IndustryAnswers = {},
): IndustryQuestion[] {
  return [
    {
      id: "businessModel",
      prompt: `What kind of ${tradeLabel} business is this?`,
      help: "This chooses default revenue accounts and what we call your customers.",
      type: "select",
      section: "business",
      required: true,
      default: defaults.businessModel ?? "mixed",
      options: [
        {
          value: "dealer",
          label: "Dealer / distributor",
          description: "Sell equipment and materials to other contractors",
        },
        {
          value: "contractor",
          label: "Installing contractor",
          description: "Sell and install for homeowners or commercial jobs",
        },
        {
          value: "service",
          label: "Service & repair",
          description: "Mostly callbacks, diagnostics, and maintenance",
        },
        {
          value: "mixed",
          label: "Sales + install + service",
          description: "A typical contractor mix",
        },
      ],
    },
    {
      id: "customerNoun",
      prompt: "What should we call the people you bill?",
      type: "select",
      section: "business",
      default: defaults.customerNoun ?? "customers",
      options: TRADES_CUSTOMER_NOUN_OPTIONS,
    },
    accountingBasisQuestion({
      prompt: "How do you want to recognize revenue?",
      default: defaults.basis ?? "accrual",
    }),
    { ...FISCAL_YEAR_QUESTION, section: "accounting" as const },
    {
      id: "revenueStreams",
      prompt: "Which revenue streams should appear on invoices?",
      type: "multiselect",
      section: "business",
      default: defaults.revenueStreams ?? ["equipment", "labor", "service", "parts"],
      options: [
        { value: "equipment", label: "Equipment / materials sales" },
        { value: "labor", label: "Installation labor" },
        { value: "service", label: "Service & repair" },
        { value: "maintenance", label: "Maintenance agreements" },
        { value: "parts", label: "Parts & accessories" },
        { value: "warranty", label: "Warranty work" },
      ],
    },
    {
      id: "trackJobs",
      prompt: "Track jobs / installs with job costing?",
      help: "Each won deal can become a job, then an invoice.",
      type: "boolean",
      section: "operations",
      default: defaults.trackJobs ?? true,
    },
    {
      id: "trackInventory",
      prompt: "Track equipment and parts inventory?",
      type: "boolean",
      section: "operations",
      default: defaults.trackInventory ?? false,
    },
    {
      id: "trackFixedAssets",
      prompt: "Track fixed assets and depreciation?",
      type: "boolean",
      section: "operations",
      default: defaults.trackFixedAssets ?? false,
    },
    {
      id: "collectTax",
      prompt: "Collect sales tax?",
      type: "boolean",
      section: "accounting",
      default: defaults.collectTax ?? true,
    },
    {
      id: "taxRate",
      prompt: "Default sales tax rate (%)",
      type: "number",
      section: "accounting",
      default: defaults.taxRate ?? 0,
    },
    {
      id: "warrantyReserve",
      prompt: "Set aside a warranty reserve on equipment sales?",
      type: "boolean",
      section: "accounting",
      default: defaults.warrantyReserve ?? false,
    },
    {
      id: "connectHfac",
      prompt: "Connect Hassle Free AC?",
      help: "Won deals in Hassle Free AC import as draft invoices via webhook.",
      type: "boolean",
      section: "integrations",
      default: defaults.connectHfac ?? false,
    },
  ];
}

export function resolveTradesPack(answers: IndustryAnswers) {
  const streams = asList(answers.revenueStreams);
  const segments = asList(answers.marketSegments);
  const modules: string[] = [...CORE_MODULES];
  if (isOn(answers.trackJobs)) modules.push("jobs");
  if (isOn(answers.trackInventory)) modules.push("inventory");
  if (isOn(answers.trackFixedAssets)) modules.push("fixed_assets");
  if (isOn(answers.connectHfac) || isOn(answers.connectQuoter)) modules.push("hfac");

  const { customer: customerLabel, customerSingular } = formatCustomerLabels(
    String(answers.customerNoun || "customers"),
  );

  const tagsToKeep = new Set<string>(["", ...streams]);
  if (isOn(answers.trackInventory)) tagsToKeep.add("inventory");
  if (isOn(answers.collectTax)) tagsToKeep.add("tax");
  if (isOn(answers.warrantyReserve) || streams.includes("warranty")) {
    tagsToKeep.add("warranty");
  }
  if (segments.includes("residential")) tagsToKeep.add("residential");
  if (segments.includes("commercial")) tagsToKeep.add("commercial");

  const accounts = TRADES_ACCOUNTS.filter((account) => {
    const tag = account.industry_tag || "";
    return !tag || tagsToKeep.has(tag);
  });

  return {
    modules,
    labels: {
      customer: customerLabel,
      customerSingular,
      job: "Jobs",
      jobSingular: "Job",
      invoice: "Invoices",
    },
    accounts,
  };
}

export function createTradesPack(config: TradesPackConfig): IndustryPack {
  return {
    id: config.id,
    name: config.name,
    shortName: config.shortName,
    tagline: config.tagline,
    description: config.description,
    category: config.category,
    recommended: config.recommended,
    questions: [
      ...buildTradesQuestions(config.tradeLabel, config.answerDefaults),
      ...(config.extraQuestions ?? []),
    ],
    resolve: resolveTradesPack,
  };
}

export const TRADES_INDUSTRY_IDS = [
  "trades-hvac",
  "trades-electrical",
  "trades-plumbing",
  "trades-roofing",
  "trades-mechanical",
  "trades-general",
] as const;

/** Legacy id stored on older organizations. */
export const LEGACY_HVAC_TRADES_ID = "hvac-trades";

export function isTradesIndustryId(id: string | null | undefined): boolean {
  if (!id) return false;
  return id === LEGACY_HVAC_TRADES_ID || (TRADES_INDUSTRY_IDS as readonly string[]).includes(id);
}
