import type {
  TaxRuleSetDefinition,
  TaxRuleSetStatus,
  TaxTreatment,
} from "./types";

const VALID_STATUSES: TaxRuleSetStatus[] = ["draft", "reviewed", "active", "retired"];
const VALID_TREATMENTS: TaxTreatment[] = [
  "taxable",
  "exempt",
  "non_taxable",
  "defer_to_manual",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function parseRuleSet(raw: unknown): TaxRuleSetDefinition {
  if (!isObject(raw)) throw new Error("Rule set must be an object");

  const status = requireString(raw.status, "status") as TaxRuleSetStatus;
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }

  const rules = Array.isArray(raw.rules) ? raw.rules : [];
  if (!rules.length) throw new Error("Rule set must include at least one rule");

  const parsedRules = rules.map((rule, index) => {
    if (!isObject(rule)) throw new Error(`rules[${index}] must be an object`);
    const action = rule.action;
    if (!isObject(action)) throw new Error(`rules[${index}].action must be an object`);

    const treatment = requireString(action.treatment, `rules[${index}].action.treatment`);
    if (!VALID_TREATMENTS.includes(treatment as TaxTreatment)) {
      throw new Error(`Invalid treatment on rules[${index}]`);
    }

    return {
      ruleKey: requireString(rule.ruleKey, `rules[${index}].ruleKey`),
      priority: Number(rule.priority ?? 100),
      conditions: isObject(rule.conditions)
        ? (rule.conditions as TaxRuleSetDefinition["rules"][number]["conditions"])
        : {},
      action: action as TaxRuleSetDefinition["rules"][number]["action"],
    };
  });

  const rates = Array.isArray(raw.rates)
    ? raw.rates.map((rate, index) => {
        if (!isObject(rate)) throw new Error(`rates[${index}] must be an object`);
        return {
          jurisdictionKey: requireString(rate.jurisdictionKey, `rates[${index}].jurisdictionKey`),
          ratePercent: Number(rate.ratePercent),
          rateType: typeof rate.rateType === "string" ? rate.rateType : "sales_tax",
          effectiveFrom: requireString(rate.effectiveFrom, `rates[${index}].effectiveFrom`),
          effectiveTo:
            typeof rate.effectiveTo === "string" ? rate.effectiveTo.slice(0, 10) : null,
          sourceCitation:
            typeof rate.sourceCitation === "string" ? rate.sourceCitation : "",
        };
      })
    : [];

  const jurisdictions = Array.isArray(raw.jurisdictions)
    ? raw.jurisdictions.map((row, index) => {
        if (!isObject(row)) throw new Error(`jurisdictions[${index}] must be an object`);
        return {
          jurisdictionKey: requireString(
            row.jurisdictionKey,
            `jurisdictions[${index}].jurisdictionKey`,
          ),
          name: requireString(row.name, `jurisdictions[${index}].name`),
          country: typeof row.country === "string" ? row.country : "US",
          state: typeof row.state === "string" ? row.state : undefined,
          county: typeof row.county === "string" ? row.county : undefined,
          city: typeof row.city === "string" ? row.city : undefined,
        };
      })
    : [];

  return {
    slug: requireString(raw.slug, "slug"),
    name: requireString(raw.name, "name"),
    version: requireString(raw.version, "version"),
    status,
    effectiveFrom: requireString(raw.effectiveFrom, "effectiveFrom").slice(0, 10),
    effectiveTo:
      typeof raw.effectiveTo === "string" ? raw.effectiveTo.slice(0, 10) : null,
    sourceDocumentation:
      typeof raw.sourceDocumentation === "string" ? raw.sourceDocumentation : "",
    jurisdictions,
    rates,
    rules: parsedRules,
  };
}

export function parseTaxRuleSetSpec(raw: unknown): TaxRuleSetDefinition {
  return parseRuleSet(raw);
}

/** Only active, in-range rule sets may drive live tax calculations. */
export function ruleSetIsEffective(
  ruleSet: Pick<TaxRuleSetDefinition, "status" | "effectiveFrom" | "effectiveTo">,
  transactionDate: string,
): boolean {
  if (ruleSet.status !== "active") return false;
  const date = transactionDate.slice(0, 10);
  if (ruleSet.effectiveFrom > date) return false;
  if (ruleSet.effectiveTo && ruleSet.effectiveTo < date) return false;
  return true;
}
