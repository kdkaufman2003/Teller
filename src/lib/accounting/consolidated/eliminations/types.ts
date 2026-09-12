export type EliminationEntryType =
  | "due_to_due_from"
  | "intercompany_pl"
  | "manual"
  | "cash_flow_reclass";

export type EliminationSourceKind = "suggested" | "manual" | "system";

export type EliminationStatus = "draft" | "suggested" | "approved" | "posted" | "reversed";

export type EliminationLineInput = {
  groupKey: string;
  accountType: string;
  accountSubtype: string;
  accountCode: string;
  accountName: string;
  sourceLegalEntityId?: string | null;
  sourceAccountId?: string | null;
  debit?: number;
  credit?: number;
  memo?: string;
};

export type EliminationEntry = {
  id: string;
  organizationId: string;
  scopeKey: string;
  legalEntityIds: string[];
  effectiveDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  entryType: EliminationEntryType;
  sourceKind: EliminationSourceKind;
  status: EliminationStatus;
  description: string;
  memo: string;
  currency: string;
  idempotencyKey: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  postedAt: string | null;
  reversedAt: string | null;
  reversesEntryId: string | null;
  reversalEntryId: string | null;
  lines: EliminationLineRow[];
  sources: EliminationSourceRow[];
};

export type EliminationLineRow = {
  id: string;
  lineNumber: number;
  groupKey: string;
  accountType: string;
  accountSubtype: string;
  accountCode: string;
  accountName: string;
  sourceLegalEntityId: string | null;
  sourceAccountId: string | null;
  debit: number;
  credit: number;
  memo: string;
};

export type EliminationSourceRow = {
  id: string;
  sourceKind: string;
  sourceId: string | null;
  sourceReference: string | null;
  metadata: Record<string, unknown>;
};

export type DueToFromEliminationSuggestion = {
  entityAId: string;
  entityBId: string;
  entityAName: string;
  entityBName: string;
  aDueFromB: number;
  bDueToA: number;
  matchedEliminableAmount: number;
  difference: number;
  warning: boolean;
  status: string;
  proposedLines: EliminationLineInput[];
  sources: Array<{
    sourceKind: "intercompany_pair" | "reconciliation";
    metadata: Record<string, unknown>;
  }>;
};

export type IntercompanyPlEliminationSuggestion = {
  intercompanyTransactionId: string;
  entityAId: string;
  entityBId: string;
  amount: number;
  description: string;
  proposedLines: EliminationLineInput[];
  sources: Array<{
    sourceKind: "intercompany_transaction";
    sourceId: string;
    metadata: Record<string, unknown>;
  }>;
};

export type ConsolidationWorksheetRow = {
  groupKey: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  entityAmounts: Record<string, number>;
  preEliminationTotal: number;
  eliminationDebit: number;
  eliminationCredit: number;
  postEliminationTotal: number;
  isIntercompany: boolean;
};

export type ConsolidationWorksheetReport = {
  scopeKey: string;
  scopeLabel: string;
  periodStart: string | null;
  periodEnd: string;
  entities: Array<{ legalEntityId: string; entityName: string; entityCode: string }>;
  rows: ConsolidationWorksheetRow[];
  totals: {
    preEliminationDebit: number;
    preEliminationCredit: number;
    eliminationDebit: number;
    eliminationCredit: number;
    postEliminationDebit: number;
    postEliminationCredit: number;
  };
  balanced: boolean;
};
