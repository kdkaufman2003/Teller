import { NextResponse } from "next/server";
import { nextNumber } from "@/lib/accounting/accounts";
import { asNumber } from "@/lib/format";
import { jsonError, requireBooks } from "@/lib/api";

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

  const { data: parties } = await supabase
    .from("teller_parties")
    .select("id, name")
    .eq("organization_id", organizationId);
  const names = new Map((parties ?? []).map((row) => [row.id, row.name]));

  return NextResponse.json({
    jobs: (data ?? []).map((row) => ({
      ...row,
      party_name: row.party_id ? names.get(row.party_id) || "" : "",
    })),
  });
}

export async function POST(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;
  const body = (await request.json()) as {
    name?: string;
    partyId?: string;
    jobType?: string;
    quotedAmount?: number;
    address?: string;
  };

  const name = String(body.name || "").trim();
  if (!name) return jsonError("Job name is required");

  const { data: existing } = await supabase
    .from("teller_jobs")
    .select("job_number")
    .eq("organization_id", organizationId);
  const jobNumber = nextNumber(
    "JOB",
    (existing ?? []).map((row) => row.job_number),
  );

  const { data, error } = await supabase
    .from("teller_jobs")
    .insert({
      organization_id: organizationId,
      job_number: jobNumber,
      name,
      party_id: body.partyId || null,
      job_type: body.jobType || "install",
      quoted_amount: asNumber(body.quotedAmount),
      address: String(body.address || "").trim(),
    })
    .select("*")
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ job: data });
}
