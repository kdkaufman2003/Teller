import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { data, error } = await supabase
    .from("teller_parties")
    .select("*")
    .eq("organization_id", organizationId)
    .in("kind", ["customer", "both"])
    .order("name");

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ customers: data ?? [] });
}

export async function POST(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;
  const body = (await request.json()) as {
    name?: string;
    email?: string;
    phone?: string;
    notes?: string;
    kind?: "customer" | "vendor" | "both";
  };

  const name = String(body.name || "").trim();
  if (!name) return jsonError("Name is required");

  const { data, error } = await supabase
    .from("teller_parties")
    .insert({
      organization_id: organizationId,
      kind: body.kind || "customer",
      name,
      email: String(body.email || "").trim(),
      phone: String(body.phone || "").trim(),
      notes: String(body.notes || "").trim(),
    })
    .select("*")
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ customer: data });
}
