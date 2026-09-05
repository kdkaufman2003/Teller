/** How an organization calculates sales tax on invoices. */
export type TaxMode = "flat" | "jurisdiction";

export type TaxRuleSetStatus = "draft" | "reviewed" | "active" | "retired";

export type TaxTreatment =
  | "taxable"
  | "exempt"
  | "non_taxable"
  | "defer_to_manual";

export type TaxLocation = {
  country?: string;
  state?: string;
  county?: string;
  city?: string;
  postalCode?: string;
};

export type TaxTransactionLine = {
  lineKey: string;
  description: string;
  amount: number;
  itemType: string;
  category?: string;
};

export type TaxCustomerContext = {
  exempt?: boolean;
  exemptionCertificateId?: string | null;
};

/** Inputs the engine evaluates — no state-specific logic here. */
export type TaxEvaluationContext = {
  transactionDate: string;
  businessLocation: TaxLocation;
  jobLocation?: TaxLocation | null;
  customer?: TaxCustomerContext;
  line: TaxTransactionLine;
};

export type TaxConditionOp = "eq" | "neq" | "in" | "not_in";

export type TaxCondition = {
  field: string;
  op: TaxConditionOp;
  value: string | number | boolean | string[];
};

export type TaxRuleConditions = {
  all?: TaxCondition[];
  any?: TaxCondition[];
};

export type TaxRuleAction =
  | {
      treatment: "taxable";
      jurisdictionKey: string;
      rateType?: string;
    }
  | {
      treatment: "exempt" | "non_taxable";
      reason: string;
    }
  | {
      treatment: "defer_to_manual";
      reason: string;
    };

export type TaxRuleDefinition = {
  ruleKey: string;
  priority: number;
  conditions: TaxRuleConditions;
  action: TaxRuleAction;
};

export type TaxRateRecord = {
  jurisdictionKey: string;
  ratePercent: number;
  rateType: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  sourceCitation: string;
};

export type TaxRuleSetDefinition = {
  slug: string;
  name: string;
  version: string;
  status: TaxRuleSetStatus;
  effectiveFrom: string;
  effectiveTo?: string | null;
  sourceDocumentation: string;
  jurisdictions?: Array<{
    jurisdictionKey: string;
    name: string;
    country?: string;
    state?: string;
    county?: string;
    city?: string;
  }>;
  rates?: TaxRateRecord[];
  rules: TaxRuleDefinition[];
};

export type TaxLineDetermination = {
  lineKey: string;
  taxTreatment: TaxTreatment;
  taxableAmount: number;
  ratePercent: number | null;
  taxAmount: number;
  jurisdictionKey: string | null;
  ruleSetSlug: string | null;
  ruleKey: string | null;
  explanation: {
    engine: "jurisdiction" | "flat_fallback";
    reason: string;
    matchedRule?: string;
    rateSource?: string;
    ruleVersion?: string;
    fallback?: boolean;
    noActiveRules?: boolean;
  };
};

export type InvoiceTaxResult = {
  mode: TaxMode;
  subtotal: number;
  tax: number;
  total: number;
  lines: TaxLineDetermination[];
};

export type LoadedTaxRuleSet = TaxRuleSetDefinition & {
  rates: TaxRateRecord[];
};
