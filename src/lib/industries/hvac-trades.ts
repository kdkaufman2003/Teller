import type { AccountSeed } from "@/types";
import type { IndustryAnswers, IndustryPack } from "./types";
import { CORE_MODULES } from "./types";

const HVAC_ACCOUNTS: AccountSeed[] = [
  { code: "1000", name: "Cash", type: "asset", subtype: "bank" },
  { code: "1100", name: "Accounts Receivable", type: "asset", subtype: "receivable" },
  { code: "1200", name: "Inventory — Equipment", type: "asset", subtype: "inventory", industry_tag: "inventory" },
  { code: "1210", name: "Inventory — Parts", type: "asset", subtype: "inventory", industry_tag: "inventory" },
  { code: "2000", name: "Accounts Payable", type: "liability", subtype: "payable" },
  { code: "2100", name: "Sales Tax Payable", type: "liability", subtype: "tax", industry_tag: "tax" },
  { code: "2200", name: "Warranty Reserve", type: "liability", subtype: "reserve", industry_tag: "warranty" },
  { code: "2300", name: "Customer Deposits", type: "liability", subtype: "deposit" },
  { code: "3000", name: "Owner's Equity", type: "equity" },
  { code: "3100", name: "Retained Earnings", type: "equity" },
  { code: "4000", name: "Equipment Sales", type: "revenue", industry_tag: "equipment" },
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
  { code: "6700", name: "Warranty Expense", type: "expense", industry_tag: "warranty" },
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

export const hvacTradesPack: IndustryPack = {
  id: "hvac-trades",
  name: "HVAC & Trades",
  shortName: "HVAC",
  tagline: "Jobs, equipment vs labor, and dealer books",
  description:
    "For installing contractors, service shops, and dealer networks. Tracks jobs, splits equipment and labor, and supports quote-to-invoice integrations.",
  recommended: true,
  questions: [
    {
      id: "businessModel",
      prompt: "What kind of HVAC or trades business is this?",
      help: "This chooses default revenue accounts and what we call your customers.",
      type: "select",
      required: true,
      default: "mixed",
      options: [
        {
          value: "dealer",
          label: "Dealer / distributor",
          description: "Sell equipment to contractors and track dealer accounts",
        },
        {
          value: "contractor",
          label: "Installing contractor",
          description: "Sell and install systems for homeowners or commercial jobs",
        },
        {
          value: "service",
          label: "Service & repair",
          description: "Mostly callbacks, diagnostics, and maintenance",
        },
        {
          value: "mixed",
          label: "Sales + install + service",
          description: "A typical dealer-contractor mix",
        },
      ],
    },
    {
      id: "customerNoun",
      prompt: "What should we call the people you bill?",
      type: "select",
      default: "dealers",
      options: [
        { value: "dealers", label: "Dealers" },
        { value: "contractors", label: "Contractors" },
        { value: "customers", label: "Customers" },
        { value: "clients", label: "Clients" },
        { value: "homeowners", label: "Homeowners" },
      ],
    },
    {
      id: "basis",
      prompt: "How do you want to recognize revenue?",
      help: "Accrual books invoices when you send them. Cash books them when money arrives.",
      type: "select",
      default: "accrual",
      options: [
        { value: "accrual", label: "Accrual (recommended for jobs and AR)" },
        { value: "cash", label: "Cash (simpler, when paid)" },
      ],
    },
    {
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
    },
    {
      id: "revenueStreams",
      prompt: "Which revenue streams should appear on invoices?",
      type: "multiselect",
      default: ["equipment", "labor", "service", "parts"],
      options: [
        { value: "equipment", label: "Equipment sales" },
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
      help: "Each won quote can become a job, then an invoice.",
      type: "boolean",
      default: true,
    },
    {
      id: "trackInventory",
      prompt: "Track equipment and parts inventory?",
      type: "boolean",
      default: false,
    },
    {
      id: "collectTax",
      prompt: "Collect sales tax?",
      type: "boolean",
      default: true,
    },
    {
      id: "taxRate",
      prompt: "Default sales tax rate (%)",
      type: "number",
      default: 0,
    },
    {
      id: "warrantyReserve",
      prompt: "Set aside a warranty reserve on equipment sales?",
      type: "boolean",
      default: false,
    },
    {
      id: "connectQuoter",
      prompt: "Connect quote-to-invoice sync?",
      help: "Import customers and won quotes as draft invoices and jobs.",
      type: "boolean",
      default: true,
    },
  ],
  resolve(answers: IndustryAnswers) {
    const streams = asList(answers.revenueStreams);
    const modules: string[] = [...CORE_MODULES];
    if (isOn(answers.trackJobs)) modules.push("jobs");
    if (isOn(answers.trackInventory)) modules.push("inventory");
    if (isOn(answers.connectQuoter)) modules.push("quoter");

    const customerNoun = String(answers.customerNoun || "dealers");
    const customerLabel =
      customerNoun.charAt(0).toUpperCase() + customerNoun.slice(1);
    const customerSingular = customerLabel.replace(/s$/, "") || "Customer";

    const tagsToKeep = new Set<string>(["", ...streams]);
    if (isOn(answers.trackInventory)) tagsToKeep.add("inventory");
    if (isOn(answers.collectTax)) tagsToKeep.add("tax");
    if (isOn(answers.warrantyReserve) || streams.includes("warranty")) {
      tagsToKeep.add("warranty");
    }

    const accounts = HVAC_ACCOUNTS.filter((account) => {
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
  },
};
