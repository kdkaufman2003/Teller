import { NextResponse } from "next/server";
import {
  importBillingEntriesFromHfac,
  recordHfacWebhookDelivery,
  type HfacBillingEntry,
} from "@/lib/integrations/hfac";
import { hfacWebhookAuthorized } from "@/lib/integrations/hfac-auth";
import { createServiceClient, hasServiceRole } from "@/lib/supabase/admin";

function normalizeEntries(body: {
  entry?: HfacBillingEntry;
  entries?: HfacBillingEntry[];
}): HfacBillingEntry[] {
  if (Array.isArray(body.entries) && body.entries.length) {
    return body.entries;
  }
  if (body.entry?.id && body.entry.companyId) {
    return [body.entry];
  }
  return [];
}

export async function POST(request: Request) {
  if (!hfacWebhookAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasServiceRole()) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is required for inbound billing" },
      { status: 500 },
    );
  }

  const body = (await request.json()) as {
    organizationId?: string;
    entry?: HfacBillingEntry;
    entries?: HfacBillingEntry[];
  };

  if (!body.organizationId) {
    return NextResponse.json({ error: "organizationId is required" }, { status: 400 });
  }

  const entries = normalizeEntries(body);
  if (!entries.length) {
    return NextResponse.json({ error: "entry or entries is required" }, { status: 400 });
  }

  const supabase = createServiceClient();

  try {
    const result = await importBillingEntriesFromHfac(
      supabase,
      body.organizationId,
      entries,
    );
    await recordHfacWebhookDelivery(supabase, body.organizationId, result, "billing");
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
