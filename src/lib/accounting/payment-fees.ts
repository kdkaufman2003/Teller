import { asNumber } from "@/lib/format";
import { accountByCode, accountBySubtype } from "./accounts";

type AccountLookup = {
  id: string;
  code: string;
  type: string;
  subtype?: string;
  name?: string;
};

export type JournalLineInput = {
  account_id: string;
  debit?: number;
  credit?: number;
  party_id?: string | null;
  job_id?: string | null;
  memo?: string;
};

export type PaymentAmountInput = {
  grossAmount: number;
  feeAmount?: number | null;
  netAmount?: number | null;
};

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Derive gross, fee, and net from whichever fields the processor sends. */
export function resolvePaymentAmounts(input: PaymentAmountInput): {
  grossAmount: number;
  feeAmount: number;
  netAmount: number;
} {
  const grossAmount = roundMoney(asNumber(input.grossAmount));
  let feeAmount =
    input.feeAmount == null ? 0 : roundMoney(asNumber(input.feeAmount));
  let netAmount =
    input.netAmount == null ? grossAmount : roundMoney(asNumber(input.netAmount));

  if (feeAmount > 0 && input.netAmount == null) {
    netAmount = roundMoney(Math.max(0, grossAmount - feeAmount));
  } else if (feeAmount <= 0 && netAmount < grossAmount) {
    feeAmount = roundMoney(grossAmount - netAmount);
  }

  if (feeAmount < 0 || feeAmount > grossAmount) feeAmount = 0;
  if (netAmount < 0) netAmount = 0;
  if (feeAmount > 0) {
    netAmount = roundMoney(Math.max(0, grossAmount - feeAmount));
  } else {
    netAmount = grossAmount;
  }

  return { grossAmount, feeAmount, netAmount };
}

/** Resolve the account for Stripe/Square/other processor fees. */
export function paymentProcessingFeeAccount(accounts: AccountLookup[]) {
  return (
    accountBySubtype(accounts, "payment_fee") ||
    accounts.find((account) =>
      /payment processing|merchant fee|processor fee|bank fee/i.test(account.name ?? ""),
    ) ||
    accountByCode(accounts, "6150") ||
    accountByCode(accounts, "6900")
  );
}

export function buildInvoicePaymentLines(input: {
  cashAccountId: string;
  arAccountId: string;
  feeAccountId?: string | null;
  grossAmount: number;
  feeAmount?: number | null;
  netAmount?: number | null;
  partyId?: string | null;
  jobId?: string | null;
  processorName?: string;
}): JournalLineInput[] {
  const { grossAmount, feeAmount, netAmount } = resolvePaymentAmounts({
    grossAmount: input.grossAmount,
    feeAmount: input.feeAmount,
    netAmount: input.netAmount,
  });

  const feeMemo = input.processorName
    ? `${input.processorName} processing fee`
    : "Payment processing fee";

  const lines: JournalLineInput[] = [
    {
      account_id: input.cashAccountId,
      debit: netAmount,
      party_id: input.partyId ?? null,
      job_id: input.jobId ?? null,
      memo: input.processorName ? `${input.processorName} deposit` : "Customer payment",
    },
  ];

  if (feeAmount > 0.009) {
    if (!input.feeAccountId) {
      throw new Error("Payment processing fee account is missing from the chart of accounts");
    }
    lines.push({
      account_id: input.feeAccountId,
      debit: feeAmount,
      party_id: input.partyId ?? null,
      job_id: input.jobId ?? null,
      memo: feeMemo,
    });
  }

  lines.push({
    account_id: input.arAccountId,
    credit: grossAmount,
    party_id: input.partyId ?? null,
    job_id: input.jobId ?? null,
    memo: "Clear accounts receivable",
  });

  return lines;
}
