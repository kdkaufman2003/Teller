export const WRITE_BOOKS_ROLES = ["owner", "admin", "bookkeeper"] as const;

export type BooksRole = "owner" | "admin" | "bookkeeper" | "viewer";

export function canWriteBooks(role: string | null | undefined): boolean {
  return WRITE_BOOKS_ROLES.includes((role ?? "") as (typeof WRITE_BOOKS_ROLES)[number]);
}

export function canViewVendorTaxInfo(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

export function canApproveBills(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}
