import { asNumber } from "@/lib/format";
import { roundMoney } from "./payment-fees";

export type DocumentLineShare = {
  lineId: string;
  jobId: string | null;
  amount: number;
};

/**
 * Proportional remaining balance for one job on a multi-job document.
 * jobShare = job-attributed line amount / total applicable line amount
 */
export function allocateDocumentRemainingByJob(
  lines: DocumentLineShare[],
  jobId: string,
  documentRemaining: number,
): number {
  const applicable = lines.filter((line) => line.jobId && asNumber(line.amount) > 0);
  const totalApplicable = applicable.reduce((sum, line) => sum + asNumber(line.amount), 0);
  if (totalApplicable <= 0.009) return 0;

  const jobAmount = applicable
    .filter((line) => line.jobId === jobId)
    .reduce((sum, line) => sum + asNumber(line.amount), 0);

  if (jobAmount <= 0.009) return 0;
  return roundMoney((jobAmount / totalApplicable) * documentRemaining);
}
