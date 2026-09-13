export type RecoveryIntegrityInput = {
  journalCount: number;
  unbalancedJournals: number;
  documentCount: number;
  paymentCount: number;
  legalEntityCount: number;
  hfacDocuments?: number;
  hfacJournals?: number;
};

export type RecoveryIntegrityIssue = {
  code: string;
  detail: string;
};

export function evaluateRecoveryIntegrity(input: RecoveryIntegrityInput): {
  ok: boolean;
  issues: RecoveryIntegrityIssue[];
} {
  const issues: RecoveryIntegrityIssue[] = [];

  if (input.unbalancedJournals > 0) {
    issues.push({
      code: "UNBALANCED_JOURNALS",
      detail: `${input.unbalancedJournals} unbalanced journal(s)`,
    });
  }
  if (input.journalCount <= 0) {
    issues.push({ code: "NO_JOURNALS", detail: "Journal count is zero" });
  }
  if (input.documentCount < 0 || input.paymentCount < 0 || input.legalEntityCount < 0) {
    issues.push({ code: "NEGATIVE_COUNTS", detail: "Negative table counts detected" });
  }
  if (input.hfacDocuments != null && input.hfacDocuments !== 8) {
    issues.push({
      code: "HFAC_DOCUMENT_DRIFT",
      detail: `HFAC documents ${input.hfacDocuments} (expected 8)`,
    });
  }
  if (input.hfacJournals != null && input.hfacJournals !== 17) {
    issues.push({
      code: "HFAC_JOURNAL_DRIFT",
      detail: `HFAC journals ${input.hfacJournals} (expected 17)`,
    });
  }

  return { ok: issues.length === 0, issues };
}

export function sumJournalLines(lines: { debit?: number | string | null; credit?: number | string | null }[]) {
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    debit += Number(line.debit ?? 0);
    credit += Number(line.credit ?? 0);
  }
  return { debit, credit, balanced: Math.abs(debit - credit) <= 0.009 };
}
