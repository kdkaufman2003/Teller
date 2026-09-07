import { asNumber } from "@/lib/format";
import { roundMoney } from "./payment-fees";
import { isBilledInvoice } from "./reports";

export type AgingBucketId = "current" | "1_30" | "31_60" | "61_90" | "90_plus";

export type AgingBucket = {
  id: AgingBucketId;
  label: string;
  amount: number;
  count: number;
};

export type AgingCustomerRow = {
  name: string;
  total: number;
  buckets: Record<AgingBucketId, number>;
};

export type AgingReport = {
  buckets: AgingBucket[];
  total: number;
  topCustomers: AgingCustomerRow[];
};

export function agingBucketForDate(referenceDate: string, asOf: string): AgingBucketId {
  const ref = new Date(referenceDate.slice(0, 10) + "T12:00:00").getTime();
  const asOfMs = new Date(asOf.slice(0, 10) + "T12:00:00").getTime();
  const days = Math.floor((asOfMs - ref) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "current";
  if (days <= 30) return "1_30";
  if (days <= 60) return "31_60";
  if (days <= 90) return "61_90";
  return "90_plus";
}

const AGING_LABELS: Record<AgingBucketId, string> = {
  current: "Current",
  "1_30": "1–30 days",
  "31_60": "31–60 days",
  "61_90": "61–90 days",
  "90_plus": "90+ days",
};

export type OpenDocumentRow = {
  id?: string;
  total: number | string;
  amount_paid?: number | string;
  issue_date: string;
  due_date?: string | null;
  party_id: string | null;
  status: string;
  posted_entry_id?: string | null;
  kind?: string;
};

export type PartyBalanceRow = {
  partyId: string;
  partyName: string;
  documentBalance: number;
  unappliedCredits: number;
  netBalance: number;
};

export type PartyBalanceReport = {
  asOf: string;
  rows: PartyBalanceRow[];
  totalDocumentBalance: number;
  totalUnappliedCredits: number;
  totalNetBalance: number;
};

function documentBalance(row: OpenDocumentRow): number {
  return roundMoney(asNumber(row.total) - asNumber(row.amount_paid));
}

function buildDocumentAging(
  rows: OpenDocumentRow[],
  partyNames: Map<string, string>,
  asOf: string,
  dueDateFor: (row: OpenDocumentRow) => string,
  balanceFor: (row: OpenDocumentRow) => number,
  topN = 5,
): AgingReport {
  const bucketTotals = new Map<AgingBucketId, { amount: number; count: number }>();
  const customerTotals = new Map<
    string,
    { name: string; total: number; buckets: Record<AgingBucketId, number> }
  >();

  for (const id of Object.keys(AGING_LABELS) as AgingBucketId[]) {
    bucketTotals.set(id, { amount: 0, count: 0 });
  }

  for (const row of rows) {
    const balance = roundMoney(balanceFor(row));
    if (balance <= 0.009) continue;

    const bucket = agingBucketForDate(dueDateFor(row), asOf);
    const current = bucketTotals.get(bucket)!;
    current.amount = roundMoney(current.amount + balance);
    current.count += 1;
    bucketTotals.set(bucket, current);

    if (row.party_id) {
      const name = partyNames.get(row.party_id) || "Unknown";
      const existing = customerTotals.get(row.party_id) ?? {
        name,
        total: 0,
        buckets: {
          current: 0,
          "1_30": 0,
          "31_60": 0,
          "61_90": 0,
          "90_plus": 0,
        },
      };
      existing.total = roundMoney(existing.total + balance);
      existing.buckets[bucket] = roundMoney(existing.buckets[bucket] + balance);
      customerTotals.set(row.party_id, existing);
    }
  }

  const buckets = (Object.keys(AGING_LABELS) as AgingBucketId[]).map((id) => ({
    id,
    label: AGING_LABELS[id],
    amount: bucketTotals.get(id)?.amount ?? 0,
    count: bucketTotals.get(id)?.count ?? 0,
  }));

  const total = roundMoney(buckets.reduce((sum, row) => sum + row.amount, 0));
  const topCustomers = [...customerTotals.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, topN);

  return { buckets, total, topCustomers };
}

/** AR aging from open invoices (canonical). */
export function buildArAging(
  invoices: OpenDocumentRow[],
  partyNames: Map<string, string>,
  asOf: string,
  topN = 5,
): AgingReport {
  return buildDocumentAging(
    invoices.filter(
      (row) =>
        (row.status === "open" || row.status === "partially_paid") &&
        isBilledInvoice(row),
    ),
    partyNames,
    asOf,
    (row) => row.due_date || row.issue_date,
    (row) => documentBalance(row),
    topN,
  );
}

/** AP aging from open bills AND unpaid expenses (canonical). */
export function buildApAging(
  documents: OpenDocumentRow[],
  partyNames: Map<string, string>,
  asOf: string,
  topN = 5,
): AgingReport {
  return buildDocumentAging(
    documents.filter(
      (row) =>
        (!row.kind || row.kind === "bill" || row.kind === "expense") &&
        (row.status === "open" || row.status === "partially_paid") &&
        Boolean(row.posted_entry_id),
    ),
    partyNames,
    asOf,
    (row) => row.due_date || row.issue_date,
    (row) => documentBalance(row),
    topN,
  );
}

export function buildCustomerBalanceReport(input: {
  parties: Array<{ id: string; name: string }>;
  invoiceRemainingByParty: Map<string, number>;
  unappliedCreditsByParty: Map<string, number>;
  asOf: string;
}): PartyBalanceReport {
  const rows: PartyBalanceRow[] = input.parties
    .map((party) => {
      const documentBalance = roundMoney(input.invoiceRemainingByParty.get(party.id) ?? 0);
      const unappliedCredits = roundMoney(input.unappliedCreditsByParty.get(party.id) ?? 0);
      const netBalance = roundMoney(documentBalance - unappliedCredits);
      return {
        partyId: party.id,
        partyName: party.name,
        documentBalance,
        unappliedCredits,
        netBalance,
      };
    })
    .filter((row) => Math.abs(row.netBalance) >= 0.005 || row.documentBalance > 0 || row.unappliedCredits > 0)
    .sort((a, b) => b.netBalance - a.netBalance);

  return {
    asOf: input.asOf,
    rows,
    totalDocumentBalance: roundMoney(rows.reduce((s, r) => s + r.documentBalance, 0)),
    totalUnappliedCredits: roundMoney(rows.reduce((s, r) => s + r.unappliedCredits, 0)),
    totalNetBalance: roundMoney(rows.reduce((s, r) => s + r.netBalance, 0)),
  };
}

export function buildVendorBalanceReport(input: {
  parties: Array<{ id: string; name: string }>;
  billRemainingByParty: Map<string, number>;
  unappliedCreditsByParty: Map<string, number>;
  asOf: string;
}): PartyBalanceReport {
  const rows: PartyBalanceRow[] = input.parties
    .map((party) => {
      const documentBalance = roundMoney(input.billRemainingByParty.get(party.id) ?? 0);
      const unappliedCredits = roundMoney(input.unappliedCreditsByParty.get(party.id) ?? 0);
      const netBalance = roundMoney(documentBalance - unappliedCredits);
      return {
        partyId: party.id,
        partyName: party.name,
        documentBalance,
        unappliedCredits,
        netBalance,
      };
    })
    .filter((row) => Math.abs(row.netBalance) >= 0.005 || row.documentBalance > 0 || row.unappliedCredits > 0)
    .sort((a, b) => b.netBalance - a.netBalance);

  return {
    asOf: input.asOf,
    rows,
    totalDocumentBalance: roundMoney(rows.reduce((s, r) => s + r.documentBalance, 0)),
    totalUnappliedCredits: roundMoney(rows.reduce((s, r) => s + r.unappliedCredits, 0)),
    totalNetBalance: roundMoney(rows.reduce((s, r) => s + r.netBalance, 0)),
  };
}
