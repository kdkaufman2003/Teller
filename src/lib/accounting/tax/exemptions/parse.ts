import type {
  ParsedTaxExemption,
  TaxExemptionLifecycleStatus,
  TaxExemptionMetadata,
  TaxExemptionRow,
} from "./types";
import type { TaxExemptionStatus } from "../types";

function parseJsonArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function parseMetadata(value: unknown): TaxExemptionMetadata {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  return {
    certificateType: typeof raw.certificateType === "string" ? raw.certificateType : undefined,
    issuingJurisdictionKey:
      typeof raw.issuingJurisdictionKey === "string" ? raw.issuingJurisdictionKey : null,
    reviewStatus:
      raw.reviewStatus === "draft" ||
      raw.reviewStatus === "needs_review" ||
      raw.reviewStatus === "approved" ||
      raw.reviewStatus === "rejected"
        ? raw.reviewStatus
        : undefined,
    notes: typeof raw.notes === "string" ? raw.notes : null,
    attachmentStoragePath:
      typeof raw.attachmentStoragePath === "string" ? raw.attachmentStoragePath : null,
    attachmentFileName: typeof raw.attachmentFileName === "string" ? raw.attachmentFileName : null,
    revokedEffectiveFrom:
      typeof raw.revokedEffectiveFrom === "string" ? raw.revokedEffectiveFrom : null,
    rejectedAt: typeof raw.rejectedAt === "string" ? raw.rejectedAt : null,
    rejectionReason: typeof raw.rejectionReason === "string" ? raw.rejectionReason : null,
    source: typeof raw.source === "string" ? raw.source : null,
    duplicateWarning: raw.duplicateWarning === true,
  };
}

export function deriveLifecycleStatus(
  row: Pick<TaxExemptionRow, "status" | "effective_to">,
  metadata: TaxExemptionMetadata,
  asOf?: string,
): TaxExemptionLifecycleStatus {
  if (metadata.reviewStatus === "rejected" || metadata.rejectedAt) return "rejected";
  if (metadata.revokedEffectiveFrom && asOf && metadata.revokedEffectiveFrom <= asOf) return "revoked";
  if (row.status === "inactive" && metadata.revokedEffectiveFrom) return "revoked";
  if (row.status === "inactive") return "revoked";
  if (metadata.reviewStatus === "needs_review") return "needs_review";
  if (row.status === "pending" || metadata.reviewStatus === "draft") return "draft";
  if (row.status === "expired") return "expired";
  if (row.effective_to && asOf && row.effective_to < asOf) return "expired";
  if (row.status === "active") return "active";
  return "draft";
}

export function parseTaxExemptionRow(row: TaxExemptionRow, asOf?: string): ParsedTaxExemption {
  const metadata = parseMetadata(row.metadata);
  return {
    id: row.id,
    organizationId: row.organization_id,
    partyId: row.party_id,
    certificateNumber: row.certificate_number,
    certificateOnFile: row.certificate_on_file,
    jurisdictionScope: parseJsonArray(row.jurisdiction_scope),
    categoryScope: parseJsonArray(row.category_scope),
    status: row.status as TaxExemptionStatus,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    metadata,
    certificateType: metadata.certificateType ?? null,
    issuingJurisdictionKey: metadata.issuingJurisdictionKey ?? null,
    reviewStatus: metadata.reviewStatus,
    notes: metadata.notes ?? null,
    lifecycleStatus: deriveLifecycleStatus(row, metadata, asOf),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function maskCertificateNumber(certificateNumber?: string | null): string {
  if (!certificateNumber?.trim()) return "—";
  const trimmed = certificateNumber.trim();
  if (trimmed.length <= 4) return "****";
  return `${"*".repeat(Math.min(trimmed.length - 4, 8))}${trimmed.slice(-4)}`;
}
