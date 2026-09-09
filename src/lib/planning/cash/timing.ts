import { addCalendarDays } from "./weeks";

export type PartyTimingOverrides = Map<
  string,
  { collectionDays?: number; paymentDays?: number }
>;

export function parsePartyOverrides(raw: unknown): PartyTimingOverrides {
  const map: PartyTimingOverrides = new Map();
  if (!raw || typeof raw !== "object") return map;

  for (const [partyId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const collectionDays =
      row.collection_days != null ? Number(row.collection_days) : undefined;
    const paymentDays = row.payment_days != null ? Number(row.payment_days) : undefined;
    if (
      (collectionDays != null && Number.isFinite(collectionDays)) ||
      (paymentDays != null && Number.isFinite(paymentDays))
    ) {
      map.set(partyId, {
        collectionDays: Number.isFinite(collectionDays!) ? Math.round(collectionDays!) : undefined,
        paymentDays: Number.isFinite(paymentDays!) ? Math.round(paymentDays!) : undefined,
      });
    }
  }
  return map;
}

export function resolveArCollectionDate(input: {
  issueDate: string;
  dueDate: string | null;
  partyId: string | null;
  defaultArDays: number;
  partyOverrides: PartyTimingOverrides;
}): { date: string; usedDefault: boolean; usedPartyOverride: boolean } {
  if (input.dueDate) {
    return { date: input.dueDate.slice(0, 10), usedDefault: false, usedPartyOverride: false };
  }

  if (input.partyId) {
    const party = input.partyOverrides.get(input.partyId);
    if (party?.collectionDays != null) {
      return {
        date: addCalendarDays(input.issueDate, party.collectionDays),
        usedDefault: false,
        usedPartyOverride: true,
      };
    }
  }

  return {
    date: addCalendarDays(input.issueDate, input.defaultArDays),
    usedDefault: true,
    usedPartyOverride: false,
  };
}

export function resolveApPaymentDate(input: {
  issueDate: string;
  dueDate: string | null;
  partyId: string | null;
  defaultApDays: number;
  partyOverrides: PartyTimingOverrides;
}): { date: string; usedDefault: boolean; usedPartyOverride: boolean } {
  if (input.dueDate) {
    return { date: input.dueDate.slice(0, 10), usedDefault: false, usedPartyOverride: false };
  }

  if (input.partyId) {
    const party = input.partyOverrides.get(input.partyId);
    if (party?.paymentDays != null) {
      return {
        date: addCalendarDays(input.issueDate, party.paymentDays),
        usedDefault: false,
        usedPartyOverride: true,
      };
    }
  }

  return {
    date: addCalendarDays(input.issueDate, input.defaultApDays),
    usedDefault: true,
    usedPartyOverride: false,
  };
}
