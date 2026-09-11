import { NextResponse } from "next/server";
import { requireBooks } from "@/lib/api";
import { listStateTaxPacks } from "@/lib/accounting/tax/state-packs";

export async function GET() {
  const books = await requireBooks();
  if ("error" in books) return books.error;

  const packs = listStateTaxPacks().map((pack) => ({
    packId: pack.packId,
    state: pack.state,
    version: pack.version,
    name: pack.name,
    status: pack.status,
    effectiveFrom: pack.effectiveFrom,
    sourceReviewedAt: pack.sourceReviewedAt,
    sourcingModel: pack.sourcingModel,
    filingFrequencyOptions: pack.filingFrequencyOptions,
  }));

  return NextResponse.json({ packs });
}
