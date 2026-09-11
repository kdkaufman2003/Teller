import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import { calculateTaxForOrganization } from "@/lib/accounting/tax/calculate-for-org";
import type { TaxCalculationInput, TaxCalculationLineInput } from "@/lib/accounting/tax/calculation/types";
import type { TaxLocationInput, TaxTreatment } from "@/lib/accounting/tax/types";

type CalculateBody = {
  transactionDate?: string;
  transactionType?: TaxCalculationInput["transactionType"];
  mode?: TaxCalculationInput["mode"];
  location?: TaxCalculationInput["location"];
  customer?: TaxCalculationInput["customer"];
  lines?: Array<{
    lineKey?: string;
    lineId?: string;
    description?: string;
    quantity?: number;
    unitAmount?: number;
    lineAmount?: number;
    taxCategory?: string;
    explicitTaxabilityOverride?: TaxTreatment;
    locationOverride?: TaxLocationInput;
    taxInclusive?: boolean;
  }>;
};

export async function POST(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const body = (await request.json()) as CalculateBody;
  const lines: TaxCalculationLineInput[] = (body.lines ?? []).map((line, index) => ({
    lineKey: line.lineKey ?? String(index),
    lineId: line.lineId ?? null,
    description: line.description,
    quantity: line.quantity,
    unitAmount: line.unitAmount,
    lineAmount: line.lineAmount,
    taxCategory: line.taxCategory ?? null,
    explicitTaxabilityOverride: line.explicitTaxabilityOverride ?? null,
    locationOverride: line.locationOverride ?? null,
    taxInclusive: line.taxInclusive,
  }));

  if (lines.length === 0) return jsonError("At least one line is required");

  const input: TaxCalculationInput = {
    transactionDate: body.transactionDate ?? new Date().toISOString().slice(0, 10),
    transactionType: body.transactionType ?? "invoice",
    mode: body.mode ?? "exclusive",
    location: body.location ?? {},
    customer: body.customer ?? null,
    lines,
  };

  const result = await calculateTaxForOrganization(supabase, organizationId, input);

  return NextResponse.json({
    ...result,
    preview: true,
    disclaimer:
      "Tax calculation is deterministic from configured Teller data. Teller does not provide tax or legal advice.",
  });
}
