import { NextResponse } from "next/server";
import { createServiceClient, hasServiceRole } from "@/lib/supabase/admin";
import { checkDatabaseReadiness } from "@/lib/operations/readiness";
import { gatherOpsStatus } from "@/lib/operations/ops-status";

function opsAuthorized(request: Request): boolean {
  const expected = process.env.TELLER_OPS_STATUS_TOKEN?.trim();
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return token.length > 0 && token === expected;
}

/** Operator status — requires TELLER_OPS_STATUS_TOKEN bearer. No secrets in response. */
export async function GET(request: Request) {
  if (!opsAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasServiceRole()) {
    return NextResponse.json({ error: "Service role not configured" }, { status: 503 });
  }

  const supabase = createServiceClient();
  const [readiness, status] = await Promise.all([
    checkDatabaseReadiness(supabase, { includeProbes: true }),
    gatherOpsStatus(supabase),
  ]);

  return NextResponse.json({
    ok: readiness.ok,
    readiness,
    status,
    timestamp: new Date().toISOString(),
  });
}
