import type { TaxFilingPeriodStatus } from "../filing/types";
import type { TaxSetupStatus } from "../types";
import type { TaxAttentionSeverity } from "./types";

export function filingPeriodStatusLabel(status: TaxFilingPeriodStatus | string): string {
  switch (status) {
    case "open":
      return "Open";
    case "ready_for_review":
      return "Ready for review";
    case "reviewed":
      return "Reviewed";
    case "filed":
      return "Filed";
    case "closed":
      return "Closed";
    case "needs_review":
      return "Needs review";
    default:
      return String(status).replaceAll("_", " ");
  }
}

export function ownerSetupStatusLabelExtended(status: TaxSetupStatus): string {
  switch (status) {
    case "configured":
      return "Configured";
    case "needs_review":
      return "Needs setup review";
    default:
      return "Not started";
  }
}

export function attentionSeverityLabel(severity: TaxAttentionSeverity): string {
  switch (severity) {
    case "critical":
      return "Critical";
    case "needs_review":
      return "Needs review";
    case "informational":
      return "Informational";
    default:
      return severity;
  }
}

export function statePackStatusLabel(status: "active" | "needs_setup" | "inactive"): string {
  switch (status) {
    case "active":
      return "Active";
    case "needs_setup":
      return "Needs setup";
    default:
      return "Inactive";
  }
}

export function jurisdictionStateCode(jurisdictionKey?: string | null): string | null {
  if (!jurisdictionKey) return null;
  const parts = jurisdictionKey.split("-");
  return parts.length >= 2 ? parts[1]! : jurisdictionKey;
}

export function ownerStatePackLabel(state: string, version?: string | null): string {
  if (!version) return `${state} configuration pack`;
  return `${state} configuration pack: ${version}`;
}
