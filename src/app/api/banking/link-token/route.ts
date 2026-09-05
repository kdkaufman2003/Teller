import { NextResponse } from "next/server";
import { jsonError, requireWriteBooks } from "@/lib/api";
import { getBankingProvider } from "@/lib/banking/provider";

export async function POST() {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const provider = getBankingProvider();
  if (!provider?.isConfigured()) {
    return jsonError("Plaid is not configured on the server (PLAID_CLIENT_ID / PLAID_SECRET)", 503);
  }

  try {
    const token = await provider.createLinkToken({
      organizationId: ctx.organizationId,
      userId: ctx.session.userId,
    });
    return NextResponse.json(token);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create link token";
    return jsonError(message, 500);
  }
}
