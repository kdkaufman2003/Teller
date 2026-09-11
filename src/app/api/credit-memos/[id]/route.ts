import { NextResponse } from "next/server";
import { applyDocumentCredit, voidCreditDocument } from "@/lib/accounting/credits";
import { openCreditMemoDocument } from "@/lib/accounting/tax/posting/open-document";
import { taxLocationFromOrg } from "@/lib/accounting/tax/posting/location";
import { TaxPostingBlockedError } from "@/lib/accounting/tax/posting/open-invoice";
import { refundCustomerCredit, reverseDocumentAllocation } from "@/lib/accounting/settlements";
import { sumCreditsAppliedFromDocument } from "@/lib/accounting/document-allocations";
import { authoritativeDocumentRemaining } from "@/lib/accounting/balances";
import { documentRemainingBalance } from "@/lib/accounting/balances";
import { asNumber, todayISO } from "@/lib/format";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;
  const { id } = await params;

  const { data: creditMemo, error } = await supabase
    .from("teller_documents")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("kind", "credit_memo")
    .eq("id", id)
    .maybeSingle();

  if (error || !creditMemo) return jsonError("Credit memo not found", 404);

  const applied = await sumCreditsAppliedFromDocument(supabase, organizationId, id);
  const unapplied = documentRemainingBalance(asNumber(creditMemo.total), applied);

  const [{ data: lines }, { data: allocations }] = await Promise.all([
    supabase.from("teller_document_lines").select("*").eq("document_id", id).order("sort_order"),
    supabase
      .from("teller_document_allocations")
      .select("id, amount, target_document_id, created_at")
      .eq("organization_id", organizationId)
      .eq("source_document_id", id),
  ]);

  return NextResponse.json({
    creditMemo: { ...creditMemo, amount_applied: applied, unapplied_balance: unapplied },
    lines: lines ?? [],
    allocations: allocations ?? [],
  });
}

export async function POST(request: Request, { params }: Params) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;
  const { id } = await params;
  const body = (await request.json()) as {
    action?: "post" | "apply" | "void" | "reverse_application" | "refund";
    targetDocumentId?: string;
    amount?: number;
    allocationId?: string;
    reason?: string;
    reversalEventId?: string;
    refundDate?: string;
    refundEventId?: string;
  };

  const { data: creditMemo, error } = await supabase
    .from("teller_documents")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("kind", "credit_memo")
    .eq("id", id)
    .maybeSingle();
  if (error || !creditMemo) return jsonError("Credit memo not found", 404);

  if (body.action === "post") {
    if (creditMemo.status !== "draft") return jsonError("Only draft credit memos can be posted", 400);
    const { data: lines } = await supabase
      .from("teller_document_lines")
      .select("id, amount, account_id, description, item_type")
      .eq("document_id", id);
    const meta = (creditMemo.metadata ?? {}) as { reason?: string; originalDocumentId?: string };
    try {
      await openCreditMemoDocument(supabase, {
        organizationId,
        documentId: id,
        partyId: creditMemo.party_id,
        jobId: creditMemo.job_id,
        issueDate: creditMemo.issue_date,
        number: creditMemo.number,
        tax: asNumber(creditMemo.tax),
        reason: meta.reason,
        location: taxLocationFromOrg(session.organization ?? {}),
        originalDocumentId: meta.originalDocumentId ?? null,
        lines: (lines ?? []).map((line) => ({
          id: line.id,
          amount: asNumber(line.amount),
          account_id: line.account_id,
          description: line.description,
          item_type: line.item_type,
        })),
        actorId: session.userId,
      });
    } catch (err) {
      if (err instanceof TaxPostingBlockedError) return jsonError(err.message, 400);
      return jsonError(err instanceof Error ? err.message : "Could not post credit memo", 400);
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "apply") {
    if (!body.targetDocumentId) return jsonError("targetDocumentId is required", 400);
    try {
      const result = await applyDocumentCredit(supabase, {
        organizationId,
        sourceDocumentId: id,
        targetDocumentId: body.targetDocumentId,
        amount: asNumber(body.amount),
        actorId: session.userId,
      });
      const targetRemaining = await authoritativeDocumentRemaining(
        supabase,
        organizationId,
        body.targetDocumentId,
        0,
      );
      return NextResponse.json({ ok: true, ...result, targetRemaining });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "Could not apply credit", 400);
    }
  }

  if (body.action === "refund") {
    if (!body.reason?.trim()) return jsonError("Refund reason is required", 400);
    try {
      const result = await refundCustomerCredit(supabase, {
        organizationId,
        creditMemoId: id,
        amount: asNumber(body.amount),
        refundDate: body.refundDate || todayISO(),
        refundEventId: body.refundEventId,
        reason: body.reason.trim(),
        actorId: session.userId,
      });
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      return jsonError(
        err instanceof Error ? err.message : "Could not refund customer credit",
        400,
      );
    }
  }

  if (body.action === "reverse_application") {
    if (!body.allocationId) return jsonError("allocationId is required", 400);
    if (!body.reason?.trim()) return jsonError("Reason is required", 400);
    try {
      const result = await reverseDocumentAllocation(supabase, {
        organizationId,
        allocationId: body.allocationId,
        reversalEventId: body.reversalEventId,
        reason: body.reason.trim(),
        actorId: session.userId,
      });
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      return jsonError(
        err instanceof Error ? err.message : "Could not reverse credit application",
        400,
      );
    }
  }

  if (body.action === "void") {
    if (creditMemo.status === "void") return NextResponse.json({ ok: true, alreadyVoid: true });
    try {
      await voidCreditDocument(supabase, {
        organizationId,
        documentId: id,
        kind: "credit_memo",
        number: creditMemo.number,
        voidDate: todayISO(),
        postedEntryId: creditMemo.posted_entry_id,
        currentStatus: creditMemo.status as "draft" | "open" | "partially_applied" | "applied" | "void",
        actorId: session.userId,
      });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "Could not void credit memo", 400);
    }
    return NextResponse.json({ ok: true });
  }

  return jsonError("Unknown action", 400);
}
