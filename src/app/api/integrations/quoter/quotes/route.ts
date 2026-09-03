import { NextResponse } from "next/server";
import { importWonQuotes } from "@/lib/integrations/quoter";
import type { QuoterQuote } from "@/lib/integrations/quoter";
import { createServiceClient, hasServiceRole } from "@/lib/supabase/admin";

function authorized(request: Request): boolean {
  const secret = process.env.TELLER_QUOTER_WEBHOOK_SECRET?.trim();
  if (!secret) return false;
  const header = request.headers.get("authorization") || "";
  return header === `Bearer ${secret}`;
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasServiceRole()) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is required for inbound quotes" },
      { status: 500 },
    );
  }

  const body = (await request.json()) as {
    organizationId?: string;
    createJobs?: boolean;
    quote?: QuoterQuote;
  };

  if (!body.organizationId || !body.quote?.id) {
    return NextResponse.json(
      { error: "organizationId and quote.id are required" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const quote: QuoterQuote = {
    ...body.quote,
    source: body.quote.source || "mini_split",
  };

  try {
    const result = await importWonQuotes(supabase, body.organizationId, [quote], {
      createJobs: body.createJobs !== false,
    });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
