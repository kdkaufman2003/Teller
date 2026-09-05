import type { TaxCondition, TaxEvaluationContext } from "./types";

function readField(context: TaxEvaluationContext, field: string): unknown {
  const parts = field.split(".");
  let current: unknown = context;

  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function compareValues(
  left: unknown,
  op: TaxCondition["op"],
  right: TaxCondition["value"],
): boolean {
  if (op === "eq") return left === right;
  if (op === "neq") return left !== right;
  if (op === "in") {
    return Array.isArray(right) && right.includes(String(left ?? ""));
  }
  if (op === "not_in") {
    return Array.isArray(right) && !right.includes(String(left ?? ""));
  }
  return false;
}

export function conditionMatches(
  context: TaxEvaluationContext,
  condition: TaxCondition,
): boolean {
  const left = readField(context, condition.field);
  if (left === undefined) return false;
  return compareValues(left, condition.op, condition.value);
}

export function conditionsMatch(
  context: TaxEvaluationContext,
  conditions: { all?: TaxCondition[]; any?: TaxCondition[] },
): boolean {
  if (conditions.all?.length) {
    if (!conditions.all.every((condition) => conditionMatches(context, condition))) {
      return false;
    }
  }

  if (conditions.any?.length) {
    if (!conditions.any.some((condition) => conditionMatches(context, condition))) {
      return false;
    }
  }

  return true;
}
