import { NextResponse } from "next/server";
import { jsonError, requireWriteBooks } from "@/lib/api";
import { connectBankFromPublicToken, syncBankConnection } from "@/lib/banking/sync";

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const body = (await request.json()) as {
    publicToken?: string;
    sync?: boolean;
    connectionId?: string;
  };

  try {
    if (body.publicToken) {
      const connected = await connectBankFromPublicToken(supabase, {
        organizationId,
        publicToken: body.publicToken,
      });

      if (body.sync !== false) {
        await syncBankConnection(supabase, {
          organizationId,
          connectionId: connected.connectionId,
        });
      }

      return NextResponse.json({ ok: true, ...connected });
    }

    if (body.connectionId && body.sync) {
      const summary = await syncBankConnection(supabase, {
        organizationId,
        connectionId: body.connectionId,
      });
      return NextResponse.json({ ok: true, summary });
    }

    return jsonError("publicToken or connectionId+sync is required");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Banking update failed";
    return jsonError(message, 500);
  }
}
