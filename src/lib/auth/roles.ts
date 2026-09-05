export const WRITE_BOOKS_ROLES = ["owner", "admin", "bookkeeper"] as const;

export type BooksRole = "owner" | "admin" | "bookkeeper" | "viewer";

export function canWriteBooks(role: string | null | undefined): boolean {
  return WRITE_BOOKS_ROLES.includes((role ?? "") as (typeof WRITE_BOOKS_ROLES)[number]);
}
