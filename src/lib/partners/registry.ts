import type { PartnerDefinition } from "./types";

export const hassleFreeAcPartner: PartnerDefinition = {
  id: "hasslefreeac",
  name: "Hassle Free AC",
  shortName: "HFAC",
  description:
    "Attach to the Hassle Free Technology Group stack — Quoter for quotes, Teller for books.",
  quoterLabel: "Quoter",
  defaultCompanyName: "Hassle Free AC Dealers",
  defaultLegalName: "Hassle-Free Technology Group LLC",
  defaultIndustryId: "hvac-trades",
};

export const partners = [hassleFreeAcPartner] as const;

export function getPartner(id: string | null | undefined) {
  if (!id) return null;
  return partners.find((partner) => partner.id === id) ?? null;
}

export function isAttachedToHfac(partnerId: string | null | undefined): boolean {
  return partnerId === "hasslefreeac";
}

export function getQuoterUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_HFAC_QUOTER_URL?.trim();
  if (!url || /your-.*\.vercel\.app/i.test(url)) return null;
  return url.replace(/\/$/, "");
}

export function getTellerPublicUrl(): string | null {
  const url =
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    process.env.NEXT_PUBLIC_TELLER_URL?.trim();
  if (!url || url.includes("localhost")) return null;
  return url.replace(/\/$/, "");
}
