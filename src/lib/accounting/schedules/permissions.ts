import type { BooksRole } from "@/lib/auth/roles";

export function canConfigureAutoPost(role: BooksRole): boolean {
  return role === "owner" || role === "admin";
}

export function canPostScheduleOccurrence(role: BooksRole): boolean {
  return role === "owner" || role === "admin" || role === "bookkeeper";
}

export function canViewSchedules(_role: BooksRole): boolean {
  return true;
}

export function assertAutoPostPrivileged(role: BooksRole): void {
  if (!canConfigureAutoPost(role)) {
    throw new Error("Only owner or admin may enable auto-post");
  }
}

export function canManageSchedules(role: BooksRole): boolean {
  return role === "owner" || role === "admin" || role === "bookkeeper";
}
