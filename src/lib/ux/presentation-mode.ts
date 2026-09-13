import type { ProfileRole } from "@/types";
import type { PresentationMode } from "@/lib/accounting/presentation-mode";

export const PRESENTATION_MODE_COOKIE = "teller_presentation_mode";

export function defaultPresentationModeForRole(role: ProfileRole | string | undefined): PresentationMode {
  if (role === "viewer" || role === "owner") return "owner";
  return "accountant";
}

export function resolvePresentationMode(input: {
  role?: ProfileRole | string;
  urlMode?: string | null;
  cookieMode?: string | null;
  orgDefault?: PresentationMode | null;
}): PresentationMode {
  if (input.urlMode === "owner" || input.urlMode === "accountant") {
    return input.urlMode;
  }
  if (input.cookieMode === "owner" || input.cookieMode === "accountant") {
    return input.cookieMode;
  }
  if (input.orgDefault === "owner" || input.orgDefault === "accountant") {
    return input.orgDefault;
  }
  return defaultPresentationModeForRole(input.role);
}

export function presentationModeLabel(mode: PresentationMode): string {
  return mode === "owner" ? "Owner view" : "Accountant view";
}
