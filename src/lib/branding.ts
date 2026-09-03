import { getPartner, isAttachedToHfac } from "@/lib/partners/registry";

export function tellerBranding(partnerId: string | null | undefined) {
  const partner = getPartner(partnerId);
  const attached = Boolean(partner);

  return {
    appName: "Teller",
    pageTitle: attached ? `Teller · ${partner!.name}` : "Teller · Industry books",
    tagline: attached
      ? `Books for ${partner!.name} — connected to Quoter, still their own ledger.`
      : "Industry books that stand on their own.",
    partnerName: partner?.name ?? null,
    partnerShortName: partner?.shortName ?? null,
    attached,
    isHfac: isAttachedToHfac(partnerId),
  };
}
