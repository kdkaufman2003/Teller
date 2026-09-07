import { asNumber } from "@/lib/format";
import { roundMoney } from "./payment-fees";

export type Vendor1099Row = {
  vendorId: string;
  vendorName: string;
  legalName: string;
  eligible1099: boolean;
  form1099Category: string;
  w9Received: boolean;
  entityType: string;
  tinStatus: "on_file" | "missing" | "restricted";
  likelyReportable: number;
  excluded: number;
  needsReview: number;
  totalPayments: number;
  reviewReasons: string[];
};

export type Vendor1099ReviewReport = {
  calendarYear: number;
  rows: Vendor1099Row[];
  totals: {
    likelyReportable: number;
    excluded: number;
    needsReview: number;
    totalPayments: number;
  };
  filingEnabled: false;
};

const CARD_METHODS = new Set([
  "card",
  "credit_card",
  "credit card",
  "debit_card",
  "debit card",
  "paypal",
  "stripe",
  "square",
  "third_party_network",
]);

export function isLikelyExcludedPaymentMethod(method: string | null | undefined): boolean {
  if (!method) return false;
  return CARD_METHODS.has(method.trim().toLowerCase());
}

export function classify1099Payment(input: {
  amount: number;
  paymentMethod: string | null | undefined;
  eligible1099: boolean;
  w9Received: boolean;
  hasTin: boolean;
}): { bucket: "likelyReportable" | "excluded" | "needsReview"; reasons: string[] } {
  const reasons: string[] = [];
  const amount = roundMoney(asNumber(input.amount));
  if (amount <= 0.009) {
    return { bucket: "excluded", reasons: ["zero_amount"] };
  }

  if (isLikelyExcludedPaymentMethod(input.paymentMethod)) {
    return { bucket: "excluded", reasons: ["card_or_third_party_network"] };
  }

  if (!input.eligible1099) {
    return { bucket: "excluded", reasons: ["not_marked_eligible"] };
  }

  if (!input.w9Received) reasons.push("w9_not_received");
  if (!input.hasTin) reasons.push("tin_missing");

  if (reasons.length) {
    return { bucket: "needsReview", reasons };
  }

  return { bucket: "likelyReportable", reasons: [] };
}

export type Vendor1099PaymentEvent = {
  vendorId: string;
  vendorName: string;
  legalName: string;
  eligible1099: boolean;
  form1099Category: string;
  w9Received: boolean;
  entityType: string;
  hasTin: boolean;
  paymentDate: string;
  amount: number;
  paymentMethod: string | null;
  paymentType: string;
};

export function build1099ReviewReport(
  events: Vendor1099PaymentEvent[],
  calendarYear: number,
): Vendor1099ReviewReport {
  const byVendor = new Map<string, Vendor1099Row>();

  for (const event of events) {
    if (!event.paymentDate.startsWith(String(calendarYear))) continue;
    if (event.paymentType !== "bill_payment") continue;

    const existing =
      byVendor.get(event.vendorId) ??
      ({
        vendorId: event.vendorId,
        vendorName: event.vendorName,
        legalName: event.legalName,
        eligible1099: event.eligible1099,
        form1099Category: event.form1099Category,
        w9Received: event.w9Received,
        entityType: event.entityType,
        tinStatus: event.hasTin ? "on_file" : "missing",
        likelyReportable: 0,
        excluded: 0,
        needsReview: 0,
        totalPayments: 0,
        reviewReasons: [],
      } satisfies Vendor1099Row);

    existing.totalPayments = roundMoney(existing.totalPayments + event.amount);
    const classification = classify1099Payment({
      amount: event.amount,
      paymentMethod: event.paymentMethod,
      eligible1099: event.eligible1099,
      w9Received: event.w9Received,
      hasTin: event.hasTin,
    });

    if (classification.bucket === "likelyReportable") {
      existing.likelyReportable = roundMoney(existing.likelyReportable + event.amount);
    } else if (classification.bucket === "excluded") {
      existing.excluded = roundMoney(existing.excluded + event.amount);
    } else {
      existing.needsReview = roundMoney(existing.needsReview + event.amount);
      for (const reason of classification.reasons) {
        if (!existing.reviewReasons.includes(reason)) existing.reviewReasons.push(reason);
      }
    }

    byVendor.set(event.vendorId, existing);
  }

  const rows = [...byVendor.values()].sort((a, b) => b.totalPayments - a.totalPayments);

  return {
    calendarYear,
    rows,
    totals: {
      likelyReportable: roundMoney(rows.reduce((s, r) => s + r.likelyReportable, 0)),
      excluded: roundMoney(rows.reduce((s, r) => s + r.excluded, 0)),
      needsReview: roundMoney(rows.reduce((s, r) => s + r.needsReview, 0)),
      totalPayments: roundMoney(rows.reduce((s, r) => s + r.totalPayments, 0)),
    },
    filingEnabled: false,
  };
}
