import { getPartner } from "@/lib/partners/registry";

export function tellerBranding(partnerId: string | null | undefined) {
  const partner = getPartner(partnerId);
  const attached = Boolean(partner);

  return {
    appName: "Teller",
    pageTitle: attached ? "Teller · Connected" : "Teller · Accounting",
    tagline: attached
      ? "Industry accounting with active integrations."
      : "Industry accounting software for trades, SaaS, and growing businesses.",
    partnerName: partner?.name ?? null,
    partnerShortName: partner?.shortName ?? null,
    attached,
  };
}
