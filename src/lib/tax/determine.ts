import type { SupabaseClient } from "@supabase/supabase-js";
import { determineInvoiceTaxFromRuleSet } from "./engine";
import { ruleSetIsEffective } from "./spec";
import { roundTaxMoney, taxAmountForLine } from "./rates";
import type {
  InvoiceTaxResult,
  LoadedTaxRuleSet,
  TaxEvaluationContext,
  TaxLineDetermination,
  TaxMode,
  TaxTransactionLine,
} from "./types";

export function flatRateDetermination(
  line: TaxTransactionLine,
  taxRatePercent: number,
  reason: string,
): TaxLineDetermination {
  const taxAmount =
    taxRatePercent > 0 ? taxAmountForLine(line.amount, taxRatePercent) : 0;

  return {
    lineKey: line.lineKey,
    taxTreatment: taxRatePercent > 0 ? "taxable" : "non_taxable",
    taxableAmount: taxRatePercent > 0 ? line.amount : 0,
    ratePercent: taxRatePercent > 0 ? taxRatePercent : null,
    taxAmount,
    jurisdictionKey: null,
    ruleSetSlug: null,
    ruleKey: null,
    explanation: {
      engine: "flat_fallback",
      reason,
      fallback: true,
    },
  };
}

export function determineInvoiceTaxFlat(input: {
  lines: TaxTransactionLine[];
  taxRatePercent: number;
  reason?: string;
}): InvoiceTaxResult {
  const reason = input.reason ?? "Organization flat sales tax rate";
  const lineResults = input.lines.map((line) =>
    flatRateDetermination(line, input.taxRatePercent, reason),
  );
  const subtotal = roundTaxMoney(input.lines.reduce((sum, line) => sum + line.amount, 0));
  const tax = roundTaxMoney(lineResults.reduce((sum, line) => sum + line.taxAmount, 0));

  return {
    mode: "flat",
    subtotal,
    tax,
    total: roundTaxMoney(subtotal + tax),
    lines: lineResults,
  };
}

export async function loadActiveRuleSets(
  supabase: SupabaseClient,
  transactionDate: string,
): Promise<LoadedTaxRuleSet[]> {
  const { data: sets, error } = await supabase
    .from("teller_tax_rule_sets")
    .select("id, slug, name, version, status, effective_from, effective_to, source_documentation")
    .eq("status", "active");

  if (error) throw new Error(error.message);

  const loaded: LoadedTaxRuleSet[] = [];

  for (const setRow of sets ?? []) {
    if (
      !ruleSetIsEffective(
        {
          status: setRow.status,
          effectiveFrom: setRow.effective_from,
          effectiveTo: setRow.effective_to,
        },
        transactionDate,
      )
    ) {
      continue;
    }

    const [{ data: setRules }, { data: setRates }] = await Promise.all([
      supabase
        .from("teller_tax_rules")
        .select("rule_key, priority, conditions, action")
        .eq("rule_set_id", setRow.id),
      supabase
        .from("teller_tax_rates")
        .select(
          "jurisdiction_key, rate_percent, rate_type, effective_from, effective_to, source_citation",
        )
        .eq("rule_set_id", setRow.id),
    ]);

    loaded.push({
      slug: setRow.slug,
      name: setRow.name,
      version: setRow.version,
      status: "active",
      effectiveFrom: setRow.effective_from,
      effectiveTo: setRow.effective_to,
      sourceDocumentation: setRow.source_documentation ?? "",
      rules: (setRules ?? []).map((row) => ({
        ruleKey: row.rule_key,
        priority: row.priority,
        conditions: row.conditions as LoadedTaxRuleSet["rules"][number]["conditions"],
        action: row.action as LoadedTaxRuleSet["rules"][number]["action"],
      })),
      rates: (setRates ?? []).map((row) => ({
        jurisdictionKey: row.jurisdiction_key,
        ratePercent: Number(row.rate_percent),
        rateType: row.rate_type,
        effectiveFrom: row.effective_from,
        effectiveTo: row.effective_to,
        sourceCitation: row.source_citation ?? "",
      })),
    });
  }

  return loaded;
}

export async function determineInvoiceTax(
  supabase: SupabaseClient,
  input: {
    mode: TaxMode;
    taxRatePercent: number;
    transactionDate: string;
    businessLocation: TaxEvaluationContext["businessLocation"];
    jobLocation?: TaxEvaluationContext["jobLocation"];
    customer?: TaxEvaluationContext["customer"];
    lines: TaxTransactionLine[];
    ruleSets?: LoadedTaxRuleSet[];
  },
): Promise<InvoiceTaxResult> {
  if (input.mode !== "jurisdiction") {
    return determineInvoiceTaxFlat({
      lines: input.lines,
      taxRatePercent: input.taxRatePercent,
    });
  }

  const ruleSets =
    input.ruleSets ??
    (await loadActiveRuleSets(supabase, input.transactionDate));

  if (!ruleSets.length) {
    const flat = determineInvoiceTaxFlat({
      lines: input.lines,
      taxRatePercent: input.taxRatePercent,
      reason:
        "No active jurisdiction rule set loaded — using organization flat rate until rules are reviewed and activated",
    });

    return {
      ...flat,
      mode: "jurisdiction",
      lines: flat.lines.map((line) => ({
        ...line,
        explanation: {
          ...line.explanation,
          noActiveRules: true,
        },
      })),
    };
  }

  const primary = ruleSets[0];
  const result = determineInvoiceTaxFromRuleSet(primary, {
    transactionDate: input.transactionDate,
    businessLocation: input.businessLocation,
    jobLocation: input.jobLocation,
    customer: input.customer,
    lines: input.lines,
  });

  return {
    mode: "jurisdiction",
    ...result,
  };
}

export async function persistTaxDeterminations(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    lineIds: Array<string | null>;
    determinations: TaxLineDetermination[];
  },
) {
  const rows = input.determinations.map((determination, index) => ({
    organization_id: input.organizationId,
    document_id: input.documentId,
    line_id: input.lineIds[index] ?? null,
    rule_set_slug: determination.ruleSetSlug,
    rule_key: determination.ruleKey,
    jurisdiction_key: determination.jurisdictionKey,
    tax_treatment: determination.taxTreatment,
    taxable_amount: determination.taxableAmount,
    rate_percent: determination.ratePercent,
    tax_amount: determination.taxAmount,
    explanation: determination.explanation,
    review_status: determination.explanation.noActiveRules ? "pending_review" : "auto",
  }));

  if (!rows.length) return;

  const { error } = await supabase.from("teller_tax_determinations").insert(rows);
  if (error) throw new Error(error.message);
}
