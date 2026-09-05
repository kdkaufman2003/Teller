import { NextResponse } from "next/server";
import { asNumber } from "@/lib/format";
import { jsonError, requireBooks } from "@/lib/api";
import {
  collectTaxEnabled,
  readOrgAccountingConfig,
  resolveOrgTaxRate,
} from "@/lib/org/config";
import { buildTaxContextFromOrg } from "@/lib/tax/context";
import { determineInvoiceTax } from "@/lib/tax/determine";
import type { TaxTransactionLine } from "@/lib/tax/types";

export async function POST(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as {
    issueDate?: string;
    jobId?: string;
    partyId?: string;
    lines?: {
      description?: string;
      quantity?: number;
      unit_price?: number;
      item_type?: string;
      category?: string;
    }[];
  };

  const lines = (body.lines || []).filter(
    (line) => line.description || asNumber(line.unit_price) > 0,
  );
  if (!lines.length) return jsonError("Add at least one line");

  const accounting = readOrgAccountingConfig(session.settings?.answers);
  const taxRatePercent = collectTaxEnabled(session.settings?.answers)
    ? resolveOrgTaxRate(session.settings?.answers)
    : 0;

  const taxLines: TaxTransactionLine[] = lines.map((line, index) => {
    const quantity = asNumber(line.quantity, 1);
    const unitPrice = asNumber(line.unit_price);
    return {
      lineKey: String(index),
      description: line.description || "Line",
      amount: quantity * unitPrice,
      itemType: line.item_type || "other",
      category: line.category,
    };
  });

  let jobLocation = null;
  if (body.jobId) {
    const { data: job } = await supabase
      .from("teller_jobs")
      .select("metadata")
      .eq("organization_id", organizationId)
      .eq("id", body.jobId)
      .maybeSingle();

    const meta =
      job?.metadata && typeof job.metadata === "object"
        ? (job.metadata as Record<string, unknown>)
        : null;
    const location =
      meta?.jobLocation && typeof meta.jobLocation === "object"
        ? (meta.jobLocation as Record<string, string>)
        : null;

    if (location) {
      jobLocation = {
        country: location.country || "US",
        state: location.state,
        county: location.county,
        city: location.city,
        postalCode: location.postalCode,
      };
    }
  }

  let customerExempt = false;
  if (body.partyId) {
    const { data: party } = await supabase
      .from("teller_parties")
      .select("metadata")
      .eq("organization_id", organizationId)
      .eq("id", body.partyId)
      .maybeSingle();
    const meta =
      party?.metadata && typeof party.metadata === "object"
        ? (party.metadata as Record<string, unknown>)
        : null;
    customerExempt = meta?.taxExempt === true;
  }

  const result = await determineInvoiceTax(supabase, {
    mode: accounting.taxMode,
    taxRatePercent,
    transactionDate: body.issueDate || new Date().toISOString().slice(0, 10),
    businessLocation: buildTaxContextFromOrg(session.organization ?? {}),
    jobLocation,
    customer: { exempt: customerExempt },
    lines: taxLines,
  });

  return NextResponse.json({
    ...result,
    taxMode: accounting.taxMode,
    disclaimer:
      "Jurisdiction tax results depend on loaded, reviewed rule sets. Teller does not claim legal tax compliance from calculations alone.",
  });
}
