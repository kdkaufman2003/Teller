import type { PartnerDefinition } from "./types";

/** Hassle Free AC — first integration partner (internal id: hasslefreeac). */
export const hassleFreeAcPartner: PartnerDefinition = {
  id: "hasslefreeac",
  name: "Hassle Free AC",
  shortName: "HFAC",
  description:
    "Import customers and won deals from Hassle Free AC as draft invoices and jobs.",
  platformLabel: "Hassle Free AC",
  defaultCompanyName: "",
  defaultLegalName: "",
  defaultIndustryId: "hvac-trades",
};

export const partners = [hassleFreeAcPartner] as const;

export function getPartner(id: string | null | undefined) {
  if (!id) return null;
  return partners.find((partner) => partner.id === id) ?? null;
}

export function isAttachedToPartner(partnerId: string | null | undefined): boolean {
  return Boolean(partnerId);
}

export function getHfacPlatformUrl(): string | null {
  const url =
    process.env.NEXT_PUBLIC_HFAC_URL?.trim() ||
    process.env.NEXT_PUBLIC_HFAC_QUOTER_URL?.trim();
  if (!url || /your-.*\.vercel\.app/i.test(url)) return null;
  return url.replace(/\/$/, "");
}

/** @deprecated use getHfacPlatformUrl */
export const getQuoterUrl = getHfacPlatformUrl;

export function getTellerPublicUrl(): string | null {
  const url =
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    process.env.NEXT_PUBLIC_TELLER_URL?.trim();
  if (!url || url.includes("localhost")) return null;
  return url.replace(/\/$/, "");
}

export function getHfacWebhookUrl(): string | null {
  const base = getTellerPublicUrl();
  if (!base) return null;
  return `${base}/api/integrations/hfac/quotes`;
}
