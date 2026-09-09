import { isValidPeriodMonth } from "@/lib/planning/budgets/periods";
import { isBudgetPnlAccountType } from "@/lib/planning/budgets/pnl-scope";
import type {
  AssumptionTargetScope,
  AssumptionType,
  ForecastAssumptionInput,
  ForecastAssumptionKind,
  ForecastAssumptionRecord,
  ForecastAssumptionValueType,
} from "./types";

const ASSUMPTION_TYPES: AssumptionType[] = [
  "percentage_change",
  "fixed_monthly_amount",
  "target_margin",
  "month_multiplier",
  "note",
];

const TARGET_SCOPES: AssumptionTargetScope[] = [
  "all_revenue",
  "all_cogs",
  "all_expense",
  "account",
];

const MAX_PERCENT = 500;

function defaultTargetScope(kind: ForecastAssumptionKind): AssumptionTargetScope {
  switch (kind) {
    case "revenue_growth":
    case "seasonality":
      return "all_revenue";
    case "material_inflation":
      return "all_cogs";
    case "labor_cost":
    case "rent_increase":
      return "all_expense";
    default:
      return "all_revenue";
  }
}

function defaultAssumptionType(
  kind: ForecastAssumptionKind,
  valueType: ForecastAssumptionValueType,
): AssumptionType {
  if (kind === "seasonality") return "month_multiplier";
  if (valueType === "currency") return "fixed_monthly_amount";
  if (valueType === "percentage") return "percentage_change";
  return "note";
}

export function normalizeAssumptionInput(input: ForecastAssumptionInput): ForecastAssumptionInput {
  const assumptionKind = input.assumptionKind ?? "general";
  const valueType = input.valueType ?? "text";
  const parameters = { ...(input.parameters ?? {}) };
  const assumptionType =
    input.assumptionType ??
    (parameters.assumptionType as AssumptionType | undefined) ??
    defaultAssumptionType(assumptionKind, valueType);
  const targetScope =
    input.targetScope ??
    (parameters.targetScope as AssumptionTargetScope | undefined) ??
    defaultTargetScope(assumptionKind);

  return {
    ...input,
    assumptionKind,
    valueType,
    assumptionType,
    targetScope,
    parameters: {
      ...parameters,
      assumptionType,
      targetScope,
    },
  };
}

export function validateAssumptionInput(
  input: ForecastAssumptionInput,
  accountsById: Map<string, { type: string; organizationId: string }>,
): ForecastAssumptionInput {
  const normalized = normalizeAssumptionInput(input);
  if (!normalized.name?.trim()) throw new Error("Assumption name is required");

  if (!ASSUMPTION_TYPES.includes(normalized.assumptionType!)) {
    throw new Error(`Unsupported assumption type: ${normalized.assumptionType}`);
  }
  if (!TARGET_SCOPES.includes(normalized.targetScope!)) {
    throw new Error(`Unsupported target scope: ${normalized.targetScope}`);
  }

  if (normalized.assumptionType === "note") {
    return normalized;
  }

  if (normalized.effectiveStartMonth && !isValidPeriodMonth(normalized.effectiveStartMonth)) {
    throw new Error("Effective start must be YYYY-MM-01");
  }
  if (normalized.effectiveEndMonth && !isValidPeriodMonth(normalized.effectiveEndMonth)) {
    throw new Error("Effective end must be YYYY-MM-01");
  }
  if (
    normalized.effectiveStartMonth &&
    normalized.effectiveEndMonth &&
    normalized.effectiveEndMonth < normalized.effectiveStartMonth
  ) {
    throw new Error("Effective end must be on or after effective start");
  }

  if (normalized.targetScope === "account") {
    if (!normalized.targetAccountId) throw new Error("Account target requires targetAccountId");
    const account = accountsById.get(normalized.targetAccountId);
    if (!account) throw new Error("Target account not found in your organization");
  }

  if (normalized.assumptionType === "percentage_change" || normalized.assumptionType === "month_multiplier") {
    if (normalized.valueNumeric == null) throw new Error("Percentage value is required");
    if (Math.abs(normalized.valueNumeric) > MAX_PERCENT) {
      throw new Error(`Percentage must be between -${MAX_PERCENT} and ${MAX_PERCENT}`);
    }
  }

  if (normalized.assumptionType === "fixed_monthly_amount") {
    if (normalized.valueNumeric == null) throw new Error("Amount is required");
  }

  if (normalized.assumptionType === "target_margin") {
    if (normalized.valueNumeric == null) throw new Error("Target margin is required");
    if (normalized.valueNumeric <= 0 || normalized.valueNumeric >= 100) {
      throw new Error("Target margin must be between 0 and 100 (exclusive)");
    }
    if (normalized.targetScope !== "all_cogs") {
      throw new Error("Target margin applies to all COGS only");
    }
  }

  if (normalized.targetScope === "all_revenue" && normalized.targetAccountId) {
    throw new Error("Category assumptions cannot also specify an account");
  }

  const scopeType =
    normalized.targetScope === "all_revenue"
      ? "revenue"
      : normalized.targetScope === "all_cogs"
        ? "cogs"
        : normalized.targetScope === "all_expense"
          ? "expense"
          : null;
  if (scopeType && normalized.targetAccountId) {
    const account = accountsById.get(normalized.targetAccountId);
    if (account && account.type !== scopeType && normalized.targetScope === "account") {
      // account scope validates type below
    }
  }

  if (normalized.targetAccountId) {
    const account = accountsById.get(normalized.targetAccountId);
    if (!account || !isBudgetPnlAccountType(account.type)) {
      throw new Error("Target account must be an operating P&L account");
    }
  }

  return normalized;
}

export function parseAssumptionRecord(row: Record<string, unknown>): ForecastAssumptionRecord {
  const parameters = (row.parameters as Record<string, unknown>) ?? {};
  const assumptionKind = (row.assumption_kind as ForecastAssumptionKind) ?? "general";
  const valueType = (row.value_type as ForecastAssumptionValueType) ?? "text";
  const assumptionType =
    (parameters.assumptionType as AssumptionType | undefined) ??
    defaultAssumptionType(assumptionKind, valueType);
  const targetScope =
    (parameters.targetScope as AssumptionTargetScope | undefined) ??
    defaultTargetScope(assumptionKind);

  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? "",
    assumptionKind,
    assumptionType,
    targetScope,
    valueType,
    valueNumeric: row.value_numeric != null ? Number(row.value_numeric) : null,
    valueText: (row.value_text as string | null) ?? null,
    effectiveStartMonth: (row.effective_start_month as string | null) ?? null,
    effectiveEndMonth: (row.effective_end_month as string | null) ?? null,
    targetAccountId: (row.target_account_id as string | null) ?? null,
    parameters,
    priority: Number(row.priority ?? 100),
  };
}
