import { NextResponse } from "next/server";
import { requireBooks } from "@/lib/api";
import { activateStateTaxPack } from "@/lib/accounting/tax/state-packs";
import { getStateTaxPack } from "@/lib/accounting/tax/state-packs/registry";

export async function POST(request: Request) {
  const books = await requireBooks();
  if ("error" in books) return books.error;

  const body = (await request.json()) as {
    packId?: string;
    registrationNumber?: string;
    filingFrequency?: "monthly" | "quarterly" | "annual" | "other";
    effectiveFrom?: string;
  };

  const packId = body.packId?.trim();
  if (!packId) {
    return NextResponse.json({ error: "packId is required" }, { status: 400 });
  }
  if (!getStateTaxPack(packId)) {
    return NextResponse.json({ error: "Unknown state tax pack" }, { status: 400 });
  }

  const result = await activateStateTaxPack(books.supabase, {
    organizationId: books.organizationId,
    packId,
    registrationNumber: body.registrationNumber ?? null,
    filingFrequency: body.filingFrequency ?? "monthly",
    effectiveFrom: body.effectiveFrom ?? new Date().toISOString().slice(0, 10),
    actorId: books.session.userId,
  });

  return NextResponse.json({ ok: true, ...result });
}
