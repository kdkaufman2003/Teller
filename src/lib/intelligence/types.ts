export type IntelligenceKind = "categorization" | "reconciliation" | "anomaly" | "insight";

export type IntelligenceStatus = "pending" | "accepted" | "dismissed";

export type IntelligenceSuggestion = {
  id?: string;
  kind: IntelligenceKind;
  fingerprint: string;
  title: string;
  description: string;
  confidence?: number;
  href?: string;
  payload?: Record<string, unknown>;
  resourceKind?: string;
  resourceId?: string;
};

export type IntelligenceInsight = {
  id: string;
  title: string;
  description: string;
  tone: "positive" | "neutral" | "warning";
};

export type IntelligenceReport = {
  narrative: string[];
  insights: IntelligenceInsight[];
  suggestions: IntelligenceSuggestion[];
  pendingCount: number;
  aiEnabled: boolean;
};

export type IntelligenceJournalEntry = {
  id: string;
  entry_date: string;
  memo: string;
  totalDebit: number;
};

export type IntelligenceExpenseRow = {
  id: string;
  issue_date: string;
  total: number;
  memo: string;
  status: string;
  metadata?: Record<string, unknown> | null;
};

export type IntelligenceBankTransaction = {
  id: string;
  posted_date: string;
  amount: number;
  name: string;
  merchant_name?: string | null;
  status?: string | null;
  match_status: string;
  match_confidence?: number | null;
};

export type IntelligenceAccountOption = {
  id: string;
  code: string;
  name: string;
};

export type IntelligenceContext = {
  netIncome: number;
  totalRevenue: number;
  openAR: number;
  openAP: number;
  collected: number;
  periodLabel: string;
  closedThrough: string | null;
  journalEntries: IntelligenceJournalEntry[];
  expenses: IntelligenceExpenseRow[];
  bankTransactions: IntelligenceBankTransaction[];
  expenseAccounts: IntelligenceAccountOption[];
  monthlyRevenue: { month: string; amount: number }[];
};
