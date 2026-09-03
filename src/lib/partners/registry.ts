import type { PartnerDefinition } from "./types";

/** First-party integration partner (internal id: hasslefreeac). */
export const tradeQuoterPartner: PartnerDefinition = {
  id: "hasslefreeac",
  name: "Quote-to-invoice sync",
  shortName: "Quotes",
  description:
    "Import customers and won quotes from your quoting platform as draft invoices and jobs.",
  quoterLabel: "Quoting platform",
  defaultCompanyName: "",
  defaultLegalName: "",
  defaultIndustryId: "hvac-trades",
};

/** @deprecated alias for internal code */
export const hassleFreeAcPartner = tradeQuoterPartner;

export const partners = [tradeQuoterPartner] as const;

export function getPartner(id: string | null | undefined) {
  if (!id) return null;
  return partners.find((partner) => partner.id === id) ?? null;
}

export function isAttachedToPartner(partnerId: string | null | undefined): boolean {
  return Boolean(partnerId);
}

/** @deprecated */
export function isAttachedToHfac(partnerId: string | null | undefined): boolean {
  return partnerId === "hasslefreeac";
}

export function getQuoterUrl(): string | null {
  const url =
    process.env.NEXT_PUBLIC_PARTNER_QUOTER_URL?.trim() ||
    process.env.NEXT_PUBLIC_HFAC_QUOTER_URL?.trim();
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
