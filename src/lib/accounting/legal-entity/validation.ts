import { LEGAL_ENTITY_TYPES, type LegalEntityType } from "./types";

const ENTITY_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

export function normalizeEntityCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "_");
}

export function validateEntityCode(code: string): { ok: boolean; reason?: string } {
  const normalized = normalizeEntityCode(code);
  if (!normalized) return { ok: false, reason: "Entity code is required" };
  if (!ENTITY_CODE_PATTERN.test(normalized)) {
    return {
      ok: false,
      reason: "Entity code must be 1–32 characters: A-Z, 0-9, underscore, hyphen",
    };
  }
  return { ok: true };
}

export function parseLegalEntityType(raw: string | null | undefined): LegalEntityType {
  const value = (raw ?? "other").trim().toLowerCase();
  if ((LEGAL_ENTITY_TYPES as readonly string[]).includes(value)) {
    return value as LegalEntityType;
  }
  return "other";
}

export function assertSameOrganization(
  organizationId: string,
  entityOrganizationId: string,
  label = "Legal entity",
): void {
  if (organizationId !== entityOrganizationId) {
    throw new Error(`${label} does not belong to this organization`);
  }
}
