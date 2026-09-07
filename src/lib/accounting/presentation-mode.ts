export type PresentationMode = "accountant" | "owner";

const OWNER_LABELS: Record<string, string> = {
  "Accounts Receivable": "Customers owe you",
  "Accounts Payable": "Bills you owe",
  "Gross Profit": "Money left after direct costs",
  "Net Income": "Profit after expenses",
  "Customer Deposits": "Customer money held for future work",
  "Retained Earnings": "Accumulated profit kept in the business",
  "Opening Balance Equity": "Starting balance from setup",
  "Current fiscal year earnings": "Profit this year (not yet closed)",
  "Prior years' earnings (derived)": "Profit from earlier years",
  "Cash collected (sales)": "Money received from sales",
  "Change in accounts receivable": "Customers paid you more or less than billed",
  "Change in accounts payable": "You paid vendors more or less than expensed",
  "Change in customer deposits": "Customer prepayments held or applied",
  "Depreciation and amortization": "Non-cash asset wear (added back)",
  "Net income (accrual)": "Profit (accrual basis)",
  "Unclassified cash flow activity (reconciliation)": "Other cash activity — review recommended",
};

const OWNER_SECTION_LABELS: Record<string, string> = {
  Revenue: "Money you earned",
  "Cost of goods sold": "Direct costs of jobs and products",
  Expenses: "Operating costs",
  Assets: "What you own",
  Liabilities: "What you owe",
  Equity: "Your stake in the business",
  Operating: "Day-to-day business cash",
  Investing: "Equipment and asset cash",
  Financing: "Owner and loan cash",
};

export function presentLabel(
  mode: PresentationMode,
  accountantLabel: string,
  overrides?: Record<string, string>,
): string {
  if (mode === "accountant") return accountantLabel;
  if (overrides?.[accountantLabel]) return overrides[accountantLabel]!;
  return OWNER_LABELS[accountantLabel] ?? accountantLabel;
}

export function presentSectionLabel(mode: PresentationMode, section: string): string {
  if (mode === "accountant") return section;
  return OWNER_SECTION_LABELS[section] ?? section;
}

export function presentAccountName(
  mode: PresentationMode,
  accountName: string,
  accountSubtype?: string | null,
): string {
  if (mode === "accountant") return accountName;
  if (accountSubtype === "receivable") return "Customers owe you";
  if (accountSubtype === "payable") return "Bills you owe";
  if (accountSubtype === "deposit") return "Customer money held for future work";
  if (accountSubtype === "bank") return "Cash in bank";
  return OWNER_LABELS[accountName] ?? accountName;
}
