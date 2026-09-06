import type {
  ReconciliationLandingAccount,
  ReconciliationSummary,
  ReconciliationWorkspacePayload,
} from "./types";

async function parseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

export async function fetchReconciliationLanding(): Promise<ReconciliationLandingAccount[]> {
  const response = await fetch("/api/banking/reconciliations?view=landing");
  const payload = await parseJson<{ accounts: ReconciliationLandingAccount[] }>(response);
  return payload.accounts;
}

export async function fetchReconciliationWorkspace(
  reconciliationId: string,
): Promise<ReconciliationWorkspacePayload> {
  const response = await fetch(
    `/api/banking/reconciliations?reconciliationId=${reconciliationId}&includeWorkspace=true`,
  );
  const payload = await parseJson<{ workspace: ReconciliationWorkspacePayload }>(response);
  return payload.workspace;
}

export async function startReconciliation(input: {
  bankAccountId: string;
  statementStartDate: string;
  statementEndDate: string;
  statementEndingBalance: number;
  beginningReconciledBalance?: number | null;
}): Promise<string> {
  const response = await fetch("/api/banking/reconciliations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "start", ...input }),
  });
  const payload = await parseJson<{ reconciliationId: string }>(response);
  return payload.reconciliationId;
}

export async function toggleReconciliationItem(input: {
  reconciliationId: string;
  bankTransactionId: string;
  cleared: boolean;
}): Promise<ReconciliationWorkspacePayload> {
  const response = await fetch("/api/banking/reconciliations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "toggle_item", ...input }),
  });
  const payload = await parseJson<{ workspace: ReconciliationWorkspacePayload }>(response);
  return payload.workspace;
}

export async function finalizeReconciliation(
  reconciliationId: string,
): Promise<ReconciliationWorkspacePayload> {
  const response = await fetch("/api/banking/reconciliations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "finalize", reconciliationId }),
  });
  const payload = await parseJson<{ workspace: ReconciliationWorkspacePayload }>(response);
  return payload.workspace;
}

export async function reopenReconciliation(input: {
  reconciliationId: string;
  reason: string;
}): Promise<ReconciliationWorkspacePayload> {
  const response = await fetch("/api/banking/reconciliations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "reopen", ...input }),
  });
  const payload = await parseJson<{ workspace: ReconciliationWorkspacePayload }>(response);
  return payload.workspace;
}

export async function fetchReconciliationHistory(bankAccountId?: string) {
  const query = bankAccountId ? `?bankAccountId=${bankAccountId}` : "";
  const response = await fetch(`/api/banking/reconciliations${query}`);
  return parseJson<{
    reconciliations: Array<Record<string, unknown> & { summary: ReconciliationSummary }>;
    suggestedBeginningBalance: number | null;
    lastCompletedReconciliation: Record<string, unknown> | null;
  }>(response);
}

export function reconciliationStatusLabel(status: string): string {
  switch (status) {
    case "in_progress":
      return "In progress";
    case "completed":
      return "Completed";
    case "reopened":
      return "Reopened";
    case "draft":
      return "Draft";
    default:
      return status.replace(/_/g, " ");
  }
}

export function canFinalize(summary: ReconciliationSummary): boolean {
  return Math.abs(summary.difference) <= 0.01;
}
