const LEGAL_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "co",
  "company",
  "corp",
  "corporation",
  "plc",
  "lp",
  "llp",
]);

export type VendorChoice = { id: string; name: string };

export type VendorMatch = VendorChoice & {
  reason: string;
};

export function normalizeVendorName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word && !LEGAL_SUFFIXES.has(word))
    .join(" ")
    .trim();
}

function pickStable(rows: { vendor: VendorChoice }[]): VendorChoice {
  return [...rows].sort((a, b) => a.vendor.id.localeCompare(b.vendor.id))[0].vendor;
}

/** Match a receipt name to a vendor already on the books. */
export function matchVendorName(rawName: string, vendors: VendorChoice[]): VendorMatch | null {
  const normalized = normalizeVendorName(rawName);
  if (!normalized) return null;

  const ranked = vendors
    .map((vendor) => ({ vendor, key: normalizeVendorName(vendor.name) }))
    .filter((row) => row.key);

  const exact = ranked.filter((row) => row.key === normalized);
  if (exact.length) {
    const vendor = pickStable(exact);
    return {
      ...vendor,
      reason: `Matched existing vendor ${vendor.name}. Change it before saving if this receipt is someone else.`,
    };
  }

  if (/^\d+$/.test(normalized) || normalized.length < 3) return null;

  const wanted = normalized.split(" ");
  const close = ranked.filter((row) => {
    const have = row.key.split(" ");
    const [shorter, longer] = wanted.length <= have.length ? [wanted, have] : [have, wanted];
    if (shorter.length === 0 || longer.length - shorter.length > 2) return false;
    if (shorter.length === 1 && shorter[0].length < 4) return false;
    return shorter.every((token) => longer.includes(token));
  });
  if (close.length !== 1) return null;

  const vendor = close[0].vendor;
  return {
    ...vendor,
    reason: `This looks like existing vendor ${vendor.name}. Change it before saving if that is wrong.`,
  };
}

export function resolveVendorSuggestion(
  extractedName: string,
  vendors: VendorChoice[],
  aiPartyId?: string | null,
): VendorMatch | null {
  const byName = matchVendorName(extractedName, vendors);
  if (byName) return byName;

  const suggested = aiPartyId ? vendors.find((vendor) => vendor.id === aiPartyId) : undefined;
  if (!suggested) return null;
  return {
    ...suggested,
    reason: `OpenAI suggested existing vendor ${suggested.name}. Change it before saving if that is wrong.`,
  };
}
