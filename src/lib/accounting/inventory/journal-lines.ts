import { roundMoney } from "../payment-fees";

export type InventoryJournalLine = {
  accountId: string;
  debit: number;
  credit: number;
  memo: string;
  jobId?: string | null;
  costClassification?: string | null;
};

export function assertInventoryJournalBalanced(lines: InventoryJournalLine[]): void {
  const debit = roundMoney(lines.reduce((sum, row) => sum + row.debit, 0));
  const credit = roundMoney(lines.reduce((sum, row) => sum + row.credit, 0));
  if (Math.abs(debit - credit) > 0.009) {
    throw new Error(`Inventory journal unbalanced: debit ${debit} vs credit ${credit}`);
  }
}

/** Purchase receipt / bill inventory line: Dr Inventory Asset, Cr AP. */
export function buildInventoryReceiptJournalLines(input: {
  amount: number;
  inventoryAssetAccountId: string;
  accountsPayableAccountId: string;
  memo?: string;
}): InventoryJournalLine[] {
  const amount = roundMoney(input.amount);
  return [
    {
      accountId: input.inventoryAssetAccountId,
      debit: amount,
      credit: 0,
      memo: input.memo ?? "Inventory receipt",
    },
    {
      accountId: input.accountsPayableAccountId,
      debit: 0,
      credit: amount,
      memo: input.memo ?? "Inventory receipt",
    },
  ];
}

/** Job issue: Dr COGS / direct material, Cr Inventory Asset. */
export function buildInventoryIssueJournalLines(input: {
  amount: number;
  cogsAccountId: string;
  inventoryAssetAccountId: string;
  jobId: string;
  memo?: string;
}): InventoryJournalLine[] {
  const amount = roundMoney(input.amount);
  return [
    {
      accountId: input.cogsAccountId,
      debit: amount,
      credit: 0,
      memo: input.memo ?? "Inventory job issue",
      jobId: input.jobId,
      costClassification: "direct",
    },
    {
      accountId: input.inventoryAssetAccountId,
      debit: 0,
      credit: amount,
      memo: input.memo ?? "Inventory job issue",
    },
  ];
}

/** Job return: Dr Inventory Asset, Cr COGS (reverse of issue at original cost). */
export function buildInventoryJobReturnJournalLines(input: {
  amount: number;
  cogsAccountId: string;
  inventoryAssetAccountId: string;
  jobId: string;
  memo?: string;
}): InventoryJournalLine[] {
  const amount = roundMoney(input.amount);
  return [
    {
      accountId: input.inventoryAssetAccountId,
      debit: amount,
      credit: 0,
      memo: input.memo ?? "Inventory job return",
    },
    {
      accountId: input.cogsAccountId,
      debit: 0,
      credit: amount,
      memo: input.memo ?? "Inventory job return",
      jobId: input.jobId,
      costClassification: "direct",
    },
  ];
}

/** Decrease adjustment: Dr shrinkage/expense, Cr Inventory Asset. */
export function buildInventoryDecreaseJournalLines(input: {
  amount: number;
  adjustmentExpenseAccountId: string;
  inventoryAssetAccountId: string;
  memo?: string;
}): InventoryJournalLine[] {
  const amount = roundMoney(input.amount);
  return [
    {
      accountId: input.adjustmentExpenseAccountId,
      debit: amount,
      credit: 0,
      memo: input.memo ?? "Inventory decrease adjustment",
    },
    {
      accountId: input.inventoryAssetAccountId,
      debit: 0,
      credit: amount,
      memo: input.memo ?? "Inventory decrease adjustment",
    },
  ];
}

/** Increase adjustment: Dr Inventory Asset, Cr adjustment gain/contra. */
export function buildInventoryIncreaseJournalLines(input: {
  amount: number;
  adjustmentGainAccountId: string;
  inventoryAssetAccountId: string;
  memo?: string;
}): InventoryJournalLine[] {
  const amount = roundMoney(input.amount);
  return [
    {
      accountId: input.inventoryAssetAccountId,
      debit: amount,
      credit: 0,
      memo: input.memo ?? "Inventory increase adjustment",
    },
    {
      accountId: input.adjustmentGainAccountId,
      debit: 0,
      credit: amount,
      memo: input.memo ?? "Inventory increase adjustment",
    },
  ];
}

/** Vendor return: Dr AP, Cr Inventory Asset. */
export function buildInventoryVendorReturnJournalLines(input: {
  amount: number;
  accountsPayableAccountId: string;
  inventoryAssetAccountId: string;
  memo?: string;
}): InventoryJournalLine[] {
  const amount = roundMoney(input.amount);
  return [
    {
      accountId: input.accountsPayableAccountId,
      debit: amount,
      credit: 0,
      memo: input.memo ?? "Inventory vendor return",
    },
    {
      accountId: input.inventoryAssetAccountId,
      debit: 0,
      credit: amount,
      memo: input.memo ?? "Inventory vendor return",
    },
  ];
}

/** Opening balance: Dr Inventory Asset, Cr Opening Balance Equity. */
export function buildOpeningInventoryJournalLines(input: {
  amount: number;
  inventoryAssetAccountId: string;
  openingBalanceEquityAccountId: string;
  memo?: string;
}): InventoryJournalLine[] {
  const amount = roundMoney(input.amount);
  return [
    {
      accountId: input.inventoryAssetAccountId,
      debit: amount,
      credit: 0,
      memo: input.memo ?? "Opening inventory balance",
    },
    {
      accountId: input.openingBalanceEquityAccountId,
      debit: 0,
      credit: amount,
      memo: input.memo ?? "Opening inventory balance",
    },
  ];
}

export function reverseInventoryJournalLines(lines: InventoryJournalLine[]): InventoryJournalLine[] {
  return lines.map((row) => ({
    ...row,
    debit: row.credit,
    credit: row.debit,
    memo: `Reversal: ${row.memo}`,
  }));
}
