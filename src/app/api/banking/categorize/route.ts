import { NextResponse } from "next/server";
import { jsonError, requireWriteBooks } from "@/lib/api";
import {
  categorizeBankTransaction,
  excludeBankTransaction,
  splitCategorizeBankTransaction,
} from "@/lib/banking/categorize";
import type { BankSplitInput, CategorizeKind } from "@/lib/banking/types";

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as {
    transactionId?: string;
    action?: "categorize" | "split";
    categoryKind?: CategorizeKind;
    accountId?: string;
    partyId?: string | null;
    jobId?: string | null;
    memo?: string;
    splits?: BankSplitInput[];
    idempotencyEventId?: string | null;
  };

  if (!body.transactionId) return jsonError("transactionId is required");

  try {
    if (body.action === "split") {
      if (!body.splits?.length) return jsonError("splits are required");
      const result = await splitCategorizeBankTransaction(supabase, {
        organizationId,
        bankTransactionId: body.transactionId,
        splits: body.splits,
        idempotencyEventId: body.idempotencyEventId,
        actorId: session.userId,
      });
      return NextResponse.json({ ok: true, ...result });
    }

    if (!body.categoryKind) return jsonError("categoryKind is required");
    if (!body.accountId) return jsonError("accountId is required");

    const result = await categorizeBankTransaction(supabase, {
      organizationId,
      bankTransactionId: body.transactionId,
      categoryKind: body.categoryKind,
      accountId: body.accountId,
      partyId: body.partyId,
      jobId: body.jobId,
      memo: body.memo,
      idempotencyEventId: body.idempotencyEventId,
      actorId: session.userId,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Categorization failed";
    return jsonError(message, 500);
  }
}

export async function DELETE(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const url = new URL(request.url);
  const transactionId = url.searchParams.get("transactionId");
  if (!transactionId) return jsonError("transactionId is required");

  try {
    const result = await excludeBankTransaction(supabase, {
      organizationId,
      bankTransactionId: transactionId,
      actorId: session.userId,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Exclude failed";
    return jsonError(message, 500);
  }
}
