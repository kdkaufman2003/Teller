import { NextResponse } from "next/server";
import { createJob } from "@/lib/accounting/jobs";
import { buildJobProfitabilitySummary } from "@/lib/accounting/job-profitability";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { data, error } = await supabase
    .from("teller_jobs")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (error) return jsonError(error.message, 500);

  const summaries = await Promise.all(
    (data ?? []).map(async (job) => {
      try {
        const profitability = await buildJobProfitabilitySummary(
          supabase,
          organizationId,
          job.id as string,
        );
        return { job, profitability };
      } catch {
        return { job, profitability: null };
      }
    }),
  );

  return NextResponse.json({ jobs: summaries });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;
  const body = (await request.json()) as {
    name?: string;
    customerPartyId?: string;
    partyId?: string;
    jobType?: string;
    description?: string;
    address?: string;
    originalContractAmount?: number;
    quotedAmount?: number;
    estimatedRevenue?: number;
    estimatedCost?: number;
    startedAt?: string;
    estimatedCompletionDate?: string;
  };

  const name = String(body.name || "").trim();
  if (!name) return jsonError("Job name is required");

  const customerPartyId = body.customerPartyId || body.partyId || null;
  const contractAmount = body.originalContractAmount ?? body.quotedAmount;

  const job = await createJob(supabase, {
    organizationId,
    name,
    customerPartyId,
    jobType: body.jobType,
    description: body.description,
    address: body.address,
    originalContractAmount: contractAmount,
    estimatedRevenue: body.estimatedRevenue ?? contractAmount,
    estimatedCost: body.estimatedCost,
    startedAt: body.startedAt,
    estimatedCompletionDate: body.estimatedCompletionDate,
    actorId: session.userId,
  });

  return NextResponse.json({ job });
}
