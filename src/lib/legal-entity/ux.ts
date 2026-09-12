/** Owner-facing company terminology and UX helpers for Phase 16I. */

export function companyBooksLabel(companyName: string, entityCode?: string | null): string {
  const code = entityCode?.trim();
  return code ? `${companyName} (${code})` : companyName;
}

export function closeReadinessUserMessage(finding: {
  key: string;
  title: string;
  description: string;
}): string {
  if (finding.key === "ar" || finding.key.startsWith("ar_")) {
    return "Accounts receivable does not match the general ledger.";
  }
  if (finding.key === "ap" || finding.key.startsWith("ap_")) {
    return "Accounts payable does not match the general ledger.";
  }
  if (finding.key === "deposits") {
    return "Customer deposits do not match the general ledger.";
  }
  if (finding.key === "trial_balance") {
    return "The trial balance is not balanced.";
  }
  if (finding.key.startsWith("bank_")) {
    return "Bank reconciliation is incomplete for a required account.";
  }
  if (finding.key.startsWith("fa_")) {
    return "Fixed asset accounts do not reconcile to the asset register.";
  }
  if (finding.key.startsWith("job_")) {
    return "Job profitability does not reconcile to the general ledger.";
  }
  return finding.description || finding.title;
}

export const ENTITY_CONTROL_USER_MESSAGES = {
  unauthorized: "You don't have access to this company's books.",
  archived: "This company is archived and cannot accept new transactions.",
  closedPeriod: (companyName: string) =>
    `This accounting period is closed for ${companyName}.`,
  crossEntityPayment: "This payment belongs to another company.",
  crossEntityAllocation: "This payment cannot be applied to a document from another company.",
  selectCompany: "Select a company before continuing.",
} as const;
