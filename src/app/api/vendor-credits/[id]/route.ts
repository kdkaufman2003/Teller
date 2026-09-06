import { NextResponse } from "next/server";
import {
  applyDocumentCredit,
  voidCreditDocument,
  postVendorCreditOpen,
} from "@/lib/accounting/credits";
import { sumCreditsAppliedFromDocument } from "@/lib/accounting/document-allocations";
import { documentRemainingBalance } from "@/lib/accounting/balances";
import { asNumber, todayISO } from "@/lib/format";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;
  const { id } = await params;

  const { data: vendorCredit, error } = await supabase
    .from("teller_documents")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("kind", "vendor_credit")
    .eq("id", id)
    .maybeSingle();

  if (error || !vendorCredit) return jsonError("Vendor credit not found", 404);

  const applied = await sumCreditsAppliedFromDocument(supabase, organizationId, id);
  const unapplied = documentRemainingBalance(asNumber(vendorCredit.total), applied);

  const [{ data: lines }, { data: allocations }] = await Promise.all([
    supabase.from("teller_document_lines").select("*").eq("document_id", id).order("sort_order"),
    supabase
      .from("teller_document_allocations")
      .select("id, amount, target_document_id, created_at")
      .eq("organization_id", organizationId)
      .eq("source_document_id", id),
  ]);

  return NextResponse.json({
    vendorCredit: { ...vendorCredit, amount_applied: applied, unapplied_balance: unapplied },
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
    action?: "post" | "apply" | "void";
    targetDocumentId?: string;
    amount?: number;
  };

  const { data: vendorCredit, error } = await supabase
    .from("teller_documents")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("kind", "vendor_credit")
    .eq("id", id)
    .maybeSingle();
  if (error || !vendorCredit) return jsonError("Vendor credit not found", 404);

  if (body.action === "post") {
    if (vendorCredit.status !== "draft") {
      return jsonError("Only draft vendor credits can be posted", 400);
    }
    const { data: lines } = await supabase
      .from("teller_document_lines")
      .select("amount, account_id, description")
      .eq("document_id", id);
    const meta = (vendorCredit.metadata ?? {}) as { reason?: string };
    try {
      await postVendorCreditOpen(supabase, {
        organizationId,
        documentId: id,
        partyId: vendorCredit.party_id,
        jobId: vendorCredit.job_id,
        issueDate: vendorCredit.issue_date,
        number: vendorCredit.number,
        tax: asNumber(vendorCredit.tax),
        reason: meta.reason,
        lines: (lines ?? []).map((line) => ({
          amount: asNumber(line.amount),
          account_id: line.account_id,
          description: line.description,
        })),
        actorId: session.userId,
      });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "Could not post vendor credit", 400);
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
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "Could not apply vendor credit", 400);
    }
  }

  if (body.action === "void") {
    if (vendorCredit.status === "void") return NextResponse.json({ ok: true, alreadyVoid: true });
    try {
      await voidCreditDocument(supabase, {
        organizationId,
        documentId: id,
        kind: "vendor_credit",
        number: vendorCredit.number,
        voidDate: todayISO(),
        postedEntryId: vendorCredit.posted_entry_id,
        currentStatus: vendorCredit.status as
          | "draft"
          | "open"
          | "partially_applied"
          | "applied"
          | "void",
        actorId: session.userId,
      });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "Could not void vendor credit", 400);
    }
    return NextResponse.json({ ok: true });
  }

  return jsonError("Unknown action", 400);
}
