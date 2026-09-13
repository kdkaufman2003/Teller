import { NextResponse } from "next/server";
import { createServiceClient, hasServiceRole } from "@/lib/supabase/admin";
import { checkDatabaseReadiness } from "@/lib/operations/readiness";

/** Public liveness/readiness — no secrets, no tenant data. */
export async function GET() {
  const timestamp = new Date().toISOString();

  if (!hasServiceRole()) {
    return NextResponse.json({
      ok: true,
      service: "teller",
      db: "unknown",
      timestamp,
      note: "Database probe unavailable without server configuration",
    });
  }

  try {
    const supabase = createServiceClient();
    const readiness = await checkDatabaseReadiness(supabase);
    return NextResponse.json(
      {
        ok: readiness.ok,
        service: "teller",
        db: readiness.db,
        timestamp,
      },
      { status: readiness.ok ? 200 : 503 },
    );
  } catch {
    return NextResponse.json(
      { ok: false, service: "teller", db: "unavailable", timestamp },
      { status: 503 },
    );
  }
}
