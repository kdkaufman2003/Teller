import type { ForecastVersionStatus } from "./types";

const ALLOWED: Record<ForecastVersionStatus, ForecastVersionStatus[]> = {
  draft: ["published", "archived"],
  published: ["archived"],
  archived: [],
};

export function canEditForecastLines(status: ForecastVersionStatus, isImmutable?: boolean): boolean {
  if (isImmutable) return false;
  return status === "draft";
}

export function isImmutableForecastVersion(status: ForecastVersionStatus, isImmutable?: boolean): boolean {
  if (isImmutable) return true;
  return status === "published" || status === "archived";
}

export function assertForecastVersionTransition(
  current: ForecastVersionStatus,
  next: ForecastVersionStatus,
): void {
  if (current === next) return;
  const allowed = ALLOWED[current] ?? [];
  if (!allowed.includes(next)) {
    throw new Error(`Cannot transition forecast version from ${current} to ${next}`);
  }
}

export function assertForecastLinesEditable(status: ForecastVersionStatus, isImmutable?: boolean): void {
  if (!canEditForecastLines(status, isImmutable)) {
    throw new Error(`Forecast version is not editable (status: ${status})`);
  }
}

export function forecastStatusLabel(status: ForecastVersionStatus): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "published":
      return "Published";
    case "archived":
      return "Archived";
  }
}
