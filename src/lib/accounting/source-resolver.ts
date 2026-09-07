import { routes } from "@/lib/routes";
import {
  accountingAdjustmentPath,
  assetPath,
  billPath,
  creditMemoPath,
  customerPath,
  expensePath,
  invoicePath,
  jobPath,
  vendorCreditPath,
  vendorPath,
} from "@/lib/routes";

export type SourceKind =
  | "invoice"
  | "bill"
  | "expense"
  | "payment"
  | "credit_memo"
  | "vendor_credit"
  | "deposit"
  | "bank_activity"
  | "fixed_asset"
  | "depreciation"
  | "adjustment"
  | "reversal"
  | "manual"
  | "unknown";

export type ResolvedSource = {
  kind: SourceKind;
  sourceKind: string | null;
  sourceId: string | null;
  label: string;
  href: string | null;
};

const SOURCE_KIND_MAP: Record<string, SourceKind> = {
  invoice: "invoice",
  expense: "expense",
  bill: "bill",
  "invoice-payment": "payment",
  "expense-payment": "payment",
  "bill-payment": "payment",
  "customer-deposit": "deposit",
  "deposit-application": "deposit",
  "deposit-refund": "deposit",
  "customer-refund": "payment",
  "credit-refund": "credit_memo",
  "invoice-writeoff": "credit_memo",
  "customer-credit": "credit_memo",
  "vendor-credit": "vendor_credit",
  "payment-reversal": "reversal",
  "deposit-application-reversal": "reversal",
  reversal: "reversal",
  adjustment: "adjustment",
  manual: "manual",
  "fixed-asset": "fixed_asset",
  "fixed-asset-depreciation": "depreciation",
  depreciation: "depreciation",
  "fixed-asset-disposal": "fixed_asset",
  "bank-import": "bank_activity",
  "bank-transfer": "bank_activity",
};

export function normalizeSourceKind(sourceKind: string | null | undefined): SourceKind {
  if (!sourceKind) return "manual";
  return SOURCE_KIND_MAP[sourceKind] ?? "unknown";
}

export function resolveJournalSource(input: {
  sourceKind: string | null | undefined;
  sourceId: string | null | undefined;
  memo?: string | null;
  reversesEntryId?: string | null;
}): ResolvedSource {
  const rawKind = input.sourceKind ?? null;
  const sourceId = input.sourceId ?? null;

  if (input.reversesEntryId) {
    return {
      kind: "reversal",
      sourceKind: rawKind,
      sourceId,
      label: input.memo ? `Reversal — ${input.memo}` : "Reversal entry",
      href: null,
    };
  }

  const kind = normalizeSourceKind(rawKind);
  const label = sourceLabel(kind, input.memo, rawKind);
  const href = sourceHref(kind, sourceId, rawKind);

  return {
    kind,
    sourceKind: rawKind,
    sourceId,
    label,
    href,
  };
}

function sourceLabel(
  kind: SourceKind,
  memo: string | null | undefined,
  rawKind: string | null,
): string {
  if (memo?.trim()) return memo.trim();
  switch (kind) {
    case "invoice":
      return "Invoice";
    case "bill":
      return "Bill";
    case "expense":
      return "Expense";
    case "payment":
      return rawKind?.includes("deposit") ? "Deposit" : "Payment";
    case "credit_memo":
      return "Credit memo / write-off";
    case "vendor_credit":
      return "Vendor credit";
    case "deposit":
      return "Customer deposit";
    case "bank_activity":
      return "Bank activity";
    case "fixed_asset":
      return "Fixed asset";
    case "depreciation":
      return "Depreciation";
    case "adjustment":
      return "Adjusting entry";
    case "reversal":
      return "Reversal";
    case "manual":
      return "Manual journal";
    default:
      return rawKind ? `Journal (${rawKind})` : "Journal entry";
  }
}

function sourceHref(
  kind: SourceKind,
  sourceId: string | null,
  rawKind: string | null,
): string | null {
  if (!sourceId) return null;

  switch (kind) {
    case "invoice":
      return invoicePath(sourceId);
    case "bill":
      return billPath(sourceId);
    case "expense":
      return expensePath(sourceId);
    case "payment":
      if (rawKind === "customer-deposit" || rawKind === "deposit-application") {
        return `${routes.app}/deposits/${sourceId}`;
      }
      return null;
    case "credit_memo":
      return creditMemoPath(sourceId);
    case "vendor_credit":
      return vendorCreditPath(sourceId);
    case "adjustment":
      return accountingAdjustmentPath(sourceId);
    case "fixed_asset":
    case "depreciation":
      return assetPath(sourceId);
    default:
      return null;
  }
}

export function resolvePartyHref(partyId: string, role: "customer" | "vendor"): string {
  return role === "customer" ? customerPath(partyId) : vendorPath(partyId);
}

export function resolveJobHref(jobId: string): string {
  return jobPath(jobId);
}
