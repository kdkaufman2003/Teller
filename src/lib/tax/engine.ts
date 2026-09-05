import { conditionsMatch } from "./conditions";
import {
  locationToEvaluationFields,
  primaryTransactionLocation,
  resolveTaxRate,
  roundTaxMoney,
  taxAmountForLine,
} from "./rates";
import type {
  LoadedTaxRuleSet,
  TaxEvaluationContext,
  TaxLineDetermination,
  TaxRuleDefinition,
  TaxTransactionLine,
} from "./types";

function buildEvaluationContext(input: {
  transactionDate: string;
  businessLocation: TaxEvaluationContext["businessLocation"];
  jobLocation?: TaxEvaluationContext["jobLocation"];
  customer?: TaxEvaluationContext["customer"];
  line: TaxTransactionLine;
}): TaxEvaluationContext {
  const transactionLocation = primaryTransactionLocation({
    jobLocation: input.jobLocation,
    businessLocation: input.businessLocation,
  });

  return {
    transactionDate: input.transactionDate.slice(0, 10),
    businessLocation: locationToEvaluationFields(input.businessLocation),
    jobLocation: input.jobLocation
      ? locationToEvaluationFields(input.jobLocation)
      : null,
    customer: input.customer ?? {},
    line: input.line,
  };
}

function findMatchingRule(
  context: TaxEvaluationContext,
  rules: TaxRuleDefinition[],
): TaxRuleDefinition | null {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);
  for (const rule of sorted) {
    if (conditionsMatch(context, rule.conditions)) {
      return rule;
    }
  }
  return null;
}

function exemptDetermination(
  line: TaxTransactionLine,
  ruleSet: LoadedTaxRuleSet,
  rule: TaxRuleDefinition,
  treatment: "exempt" | "non_taxable",
  reason: string,
): TaxLineDetermination {
  return {
    lineKey: line.lineKey,
    taxTreatment: treatment,
    taxableAmount: 0,
    ratePercent: null,
    taxAmount: 0,
    jurisdictionKey: null,
    ruleSetSlug: ruleSet.slug,
    ruleKey: rule.ruleKey,
    explanation: {
      engine: "jurisdiction",
      reason,
      matchedRule: rule.ruleKey,
      ruleVersion: ruleSet.version,
    },
  };
}

export function determineLineTax(
  ruleSet: LoadedTaxRuleSet,
  input: {
    transactionDate: string;
    businessLocation: TaxEvaluationContext["businessLocation"];
    jobLocation?: TaxEvaluationContext["jobLocation"];
    customer?: TaxEvaluationContext["customer"];
    line: TaxTransactionLine;
  },
): TaxLineDetermination {
  const context = buildEvaluationContext(input);
  const rule = findMatchingRule(context, ruleSet.rules);

  if (!rule) {
    return {
      lineKey: input.line.lineKey,
      taxTreatment: "defer_to_manual",
      taxableAmount: 0,
      ratePercent: null,
      taxAmount: 0,
      jurisdictionKey: null,
      ruleSetSlug: ruleSet.slug,
      ruleKey: null,
      explanation: {
        engine: "jurisdiction",
        reason: "No matching tax rule for this line",
        ruleVersion: ruleSet.version,
      },
    };
  }

  const action = rule.action;

  if (action.treatment === "exempt" || action.treatment === "non_taxable") {
    return exemptDetermination(
      input.line,
      ruleSet,
      rule,
      action.treatment,
      action.reason,
    );
  }

  if (action.treatment === "defer_to_manual") {
    return {
      lineKey: input.line.lineKey,
      taxTreatment: "defer_to_manual",
      taxableAmount: 0,
      ratePercent: null,
      taxAmount: 0,
      jurisdictionKey: null,
      ruleSetSlug: ruleSet.slug,
      ruleKey: rule.ruleKey,
      explanation: {
        engine: "jurisdiction",
        reason: action.reason,
        matchedRule: rule.ruleKey,
        ruleVersion: ruleSet.version,
      },
    };
  }

  if (action.treatment !== "taxable") {
    throw new Error("Expected taxable action");
  }

  const rate = resolveTaxRate(ruleSet.rates, {
    jurisdictionKey: action.jurisdictionKey,
    transactionDate: input.transactionDate,
    rateType: action.rateType,
  });

  if (!rate) {
    return {
      lineKey: input.line.lineKey,
      taxTreatment: "defer_to_manual",
      taxableAmount: input.line.amount,
      ratePercent: null,
      taxAmount: 0,
      jurisdictionKey: action.jurisdictionKey,
      ruleSetSlug: ruleSet.slug,
      ruleKey: rule.ruleKey,
      explanation: {
        engine: "jurisdiction",
        reason: "No effective rate found for matched jurisdiction",
        matchedRule: rule.ruleKey,
        ruleVersion: ruleSet.version,
      },
    };
  }

  const taxAmount = taxAmountForLine(input.line.amount, rate.ratePercent);

  return {
    lineKey: input.line.lineKey,
    taxTreatment: "taxable",
    taxableAmount: input.line.amount,
    ratePercent: rate.ratePercent,
    taxAmount,
    jurisdictionKey: action.jurisdictionKey,
    ruleSetSlug: ruleSet.slug,
    ruleKey: rule.ruleKey,
    explanation: {
      engine: "jurisdiction",
      reason: "Matched tax rule applied effective jurisdiction rate",
      matchedRule: rule.ruleKey,
      rateSource: rate.sourceCitation || rate.jurisdictionKey,
      ruleVersion: ruleSet.version,
    },
  };
}

export function determineInvoiceTaxFromRuleSet(
  ruleSet: LoadedTaxRuleSet,
  input: {
    transactionDate: string;
    businessLocation: TaxEvaluationContext["businessLocation"];
    jobLocation?: TaxEvaluationContext["jobLocation"];
    customer?: TaxEvaluationContext["customer"];
    lines: TaxTransactionLine[];
  },
) {
  const lineResults = input.lines.map((line) =>
    determineLineTax(ruleSet, {
      transactionDate: input.transactionDate,
      businessLocation: input.businessLocation,
      jobLocation: input.jobLocation,
      customer: input.customer,
      line,
    }),
  );

  const subtotal = roundTaxMoney(input.lines.reduce((sum, line) => sum + line.amount, 0));
  const tax = roundTaxMoney(lineResults.reduce((sum, line) => sum + line.taxAmount, 0));

  return {
    subtotal,
    tax,
    total: roundTaxMoney(subtotal + tax),
    lines: lineResults,
  };
}
