import type { TaxRegistrationRecord, TaxSettingsRecord, TaxSetupStatus } from "./types";

export type TaxReadinessInput = {
  settings?: Pick<
    TaxSettingsRecord,
    "salesTaxPayableAccountId" | "setupStatus"
  > | null;
  registrations?: Pick<TaxRegistrationRecord, "status">[];
  hasActiveRates?: boolean;
  hasTaxabilityRules?: boolean;
  unresolvedDeterminationCount?: number;
};

export type TaxReadinessCheck = {
  key: string;
  label: string;
  passed: boolean;
  ownerLabel: string;
};

export function evaluateTaxReadiness(input: TaxReadinessInput): {
  status: TaxSetupStatus;
  checks: TaxReadinessCheck[];
} {
  const checks: TaxReadinessCheck[] = [
    {
      key: "liability_account",
      label: "Sales & Use Tax Payable account selected",
      ownerLabel: "Tax Payable account",
      passed: Boolean(input.settings?.salesTaxPayableAccountId),
    },
    {
      key: "registration",
      label: "At least one active tax registration",
      ownerLabel: "Where You Collect Tax",
      passed: (input.registrations ?? []).some((r) => r.status === "active"),
    },
    {
      key: "rates",
      label: "Tax rates available for configured jurisdictions",
      ownerLabel: "Tax rates configured",
      passed: Boolean(input.hasActiveRates),
    },
    {
      key: "rules",
      label: "Taxability rules or reference configuration available",
      ownerLabel: "Tax rules configured",
      passed: Boolean(input.hasTaxabilityRules || input.hasActiveRates),
    },
  ];

  const passedCount = checks.filter((c) => c.passed).length;
  let status: TaxSetupStatus = "not_configured";
  if (passedCount === checks.length && (input.unresolvedDeterminationCount ?? 0) === 0) {
    status = "configured";
  } else if (passedCount > 0 || (input.unresolvedDeterminationCount ?? 0) > 0) {
    status = "needs_review";
  }

  return { status, checks };
}

export function ownerSetupStatusLabel(status: TaxSetupStatus): string {
  switch (status) {
    case "configured":
      return "Configured";
    case "needs_review":
      return "Needs Review";
    default:
      return "Not Configured";
  }
}
