import { NextResponse } from "next/server";
import { requireBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const [customers, vendors, jobs, accounts] = await Promise.all([
    supabase
      .from("teller_parties")
      .select("id, name, kind")
      .eq("organization_id", organizationId)
      .in("kind", ["customer", "both"])
      .order("name"),
    supabase
      .from("teller_parties")
      .select("id, name")
      .eq("organization_id", organizationId)
      .in("kind", ["vendor", "both"])
      .order("name"),
    supabase
      .from("teller_jobs")
      .select("id, job_number, name")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false }),
    supabase
      .from("teller_accounts")
      .select("id, code, name, type")
      .eq("organization_id", organizationId)
      .eq("archived", false)
      .order("code"),
  ]);

  return NextResponse.json({
    customers: customers.data ?? [],
    vendors: vendors.data ?? [],
    jobs: jobs.data ?? [],
    accounts: accounts.data ?? [],
    settings: session.settings,
    taxRate: Number(session.settings?.answers?.taxRate || 0),
  });
}
