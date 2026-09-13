import { ENTITY_CONTROL_USER_MESSAGES } from "@/lib/legal-entity/ux";

/** Map server/accounting errors to owner-friendly user messages. */
export function mapUserFacingError(raw: string): string {
  const message = raw.trim();
  const upper = message.toUpperCase();

  if (upper.includes("PERIOD_CLOSED") || upper.includes("BOOKS CLOSED")) {
    return "This accounting period is closed. Ask an admin to reopen the period if you need to post here.";
  }
  if (upper.includes("ACCOUNTING_STATE_CHANGED")) {
    return "Books changed while you were working. Refresh the page and try again.";
  }
  if (upper.includes("UNAUTHORIZED_ENTITY") || upper.includes("ENTITY_ACCESS")) {
    return ENTITY_CONTROL_USER_MESSAGES.unauthorized;
  }
  if (upper.includes("OVERALLOCATION") || upper.includes("ALLOCATION EXCEEDS")) {
    return "That payment amount exceeds what is still owed on the document.";
  }
  if (upper.includes("IDEMPOTENCY") || upper.includes("ALREADY PROCESSED")) {
    return "This was already recorded. Refresh to see the latest status.";
  }
  if (upper.includes("INVALID_CONTROL_ACCOUNT")) {
    return "That account cannot be used for this transaction. Choose a different account.";
  }
  if (upper.includes("NOT AUTHENTICATED") || upper.includes("UNAUTHORIZED")) {
    return "You don't have permission to do that.";
  }
  if (upper.includes("DUPLICATE") && upper.includes("PAYMENT")) {
    return "This payment may already exist. Check recent payments before retrying.";
  }

  return message;
}
