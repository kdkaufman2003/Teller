import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import { reconcileAndPersistTaxPeriod, transitionTaxFilingPeriodStatus } from "@/lib/accounting/tax/filing";
import { loadTaxPeriodPaymentSummary } from "@/lib/accounting/tax/payments";
import type { TaxFilingPeriodStatus } from "@/lib/accounting/tax/filing/types";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;
  const { id } = await params;

  try {
    const { data, error } = await supabase!
      .from("teller_tax_filing_periods")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return jsonError("Filing period not found", 404);
    const period = {
      id: data.id as string,
      registrationId: data.registration_id as string,
      periodStart: data.period_start as string,
      periodEnd: data.period_end as string,
      filingFrequency: data.filing_frequency as string,
      status: data.status as string,
      jurisdictionKey: data.jurisdiction_key as string | null,
      metadata: (data.metadata as Record<string, unknown> | null) ?? {},
    };
    let paymentSummary = null;
    try {
      paymentSummary = await loadTaxPeriodPaymentSummary(supabase, {
        organizationId,
        filingPeriodId: id,
      });
    } catch {
      paymentSummary = null;
    }
    return NextResponse.json({ period, paymentSummary });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load filing period", 400);
  }
}

export async function POST(request: Request, { params }: Params) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;
  const { id } = await params;
  const body = (await request.json()) as {
    action?: "reconcile" | "transition";
    toStatus?: TaxFilingPeriodStatus;
  };

  try {
    if (body.action === "reconcile") {
      const result = await reconcileAndPersistTaxPeriod(supabase, {
        organizationId,
        filingPeriodId: id,
        actorId: session.userId,
      });
      return NextResponse.json({ reconciliation: result });
    }

    if (body.action === "transition") {
      if (!body.toStatus) return jsonError("toStatus is required", 400);
      const period = await transitionTaxFilingPeriodStatus(supabase, {
        organizationId,
        filingPeriodId: id,
        toStatus: body.toStatus,
        actorId: session.userId,
      });
      return NextResponse.json({ period });
    }

    return jsonError("Unsupported action", 400);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not update filing period", 400);
  }
}
