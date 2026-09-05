import type { BooksRole } from "@/lib/auth/roles";

export function parseCpaMode(value: unknown): boolean {
  return value === true || value === "true" || value === "yes";
}

export function canManagePeriodClose(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

export function canPostAdjustments(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin" || role === "bookkeeper";
}

/** Viewers may export when CPA mode is enabled for the org. */
export function canExportBooks(role: BooksRole | string | null | undefined, cpaMode: boolean): boolean {
  if (cpaMode) return true;
  return role === "owner" || role === "admin" || role === "bookkeeper";
}
