import { NextResponse } from "next/server";
import { submitBillForApproval } from "@/lib/accounting/bill-approval";
import { nextNumber } from "@/lib/accounting/accounts";
import {
  authoritativeDocumentRemaining,
  enrichDocumentsWithAuthoritativePaid,
} from "@/lib/accounting/balances";
import { recordAuditEvent } from "@/lib/accounting/audit";
import { detectDuplicateBillWarnings } from "@/lib/accounting/duplicate-bills";
import { asNumber, todayISO } from "@/lib/format";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { data, error } = await supabase
    .from("teller_documents")
    .select(
      "id, number, status, total, amount_paid, issue_date, due_date, memo, party_id, job_id, reference_number",
    )
    .eq("organization_id", organizationId)
    .eq("kind", "bill")
    .order("issue_date", { ascending: false });

  if (error) return jsonError(error.message, 500);

  const [{ data: parties }, enriched] = await Promise.all([
    supabase.from("teller_parties").select("id, name").eq("organization_id", organizationId),
    enrichDocumentsWithAuthoritativePaid(supabase, organizationId, data ?? []),
  ]);

  const partyNames = new Map((parties ?? []).map((row) => [row.id, row.name]));

  const rows = await Promise.all(
    enriched.map(async (row) => ({
      ...row,
      party_name: row.party_id ? partyNames.get(row.party_id) || "" : "",
      remaining_balance: await authoritativeDocumentRemaining(
        supabase,
        organizationId,
        row.id,
        asNumber(row.total),
      ),
    })),
  );

  return NextResponse.json({ bills: rows });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as {
    partyId?: string;
    vendorName?: string;
    jobId?: string;
    issueDate?: string;
    dueDate?: string;
    memo?: string;
    referenceNumber?: string;
    terms?: string;
    tax?: number;
    post?: boolean;
    lines?: {
      description?: string;
      quantity?: number;
      unit_price?: number;
      accountId?: string;
      jobId?: string;
      costCategory?: string;
      costType?: string;
      costClassification?: string;
    }[];
    acknowledgeDuplicateWarnings?: boolean;
    duplicateWarningContext?: Record<string, unknown>;
    accrualAllocations?: Array<{ occurrenceId: string; appliedAmount: number }>;
    settlementIdempotencyKey?: string;
  };

  const lines = (body.lines || []).filter(
    (line) => line.description || asNumber(line.unit_price) > 0,
  );
  if (!lines.length) return jsonError("Add at least one line");

  let partyId = body.partyId || null;
  if (!partyId && body.vendorName?.trim()) {
    const { data: vendor, error } = await supabase
      .from("teller_parties")
      .insert({
        organization_id: organizationId,
        kind: "vendor",
        name: body.vendorName.trim(),
      })
      .select("id")
      .single();
    if (error) return jsonError(error.message, 500);
    partyId = vendor.id;
  }
  if (!partyId) return jsonError("Vendor is required");

  const built = lines.map((line, index) => {
    const quantity = asNumber(line.quantity, 1);
    const unitPrice = asNumber(line.unit_price);
    const amount = quantity * unitPrice;
    return {
      description: line.description || "Line",
      quantity,
      unit_price: unitPrice,
      amount,
      account_id: line.accountId || null,
      job_id: line.jobId || null,
      cost_category: line.costCategory || "",
      cost_type: line.costType || "",
      cost_classification: line.costClassification || "direct",
      item_type: "expense",
      sort_order: index,
    };
  });

  const subtotal = built.reduce((sum, line) => sum + line.amount, 0);
  const tax = asNumber(body.tax);
  const total = subtotal + tax;
  const issueDate = body.issueDate || todayISO();

  const duplicateWarnings = await detectDuplicateBillWarnings(supabase, {
    organizationId,
    partyId,
    referenceNumber: body.referenceNumber,
    total,
    issueDate,
  });
  if (duplicateWarnings.length && !body.acknowledgeDuplicateWarnings) {
    return NextResponse.json({ duplicateWarnings }, { status: 409 });
  }

  const { data: existing } = await supabase
    .from("teller_documents")
    .select("number")
    .eq("organization_id", organizationId)
    .eq("kind", "bill");
  const number = nextNumber(
    "BILL",
    (existing ?? []).map((row) => row.number),
  );

  const { data: doc, error } = await supabase
    .from("teller_documents")
    .insert({
      organization_id: organizationId,
      kind: "bill",
      number,
      party_id: partyId,
      job_id: body.jobId || null,
      status: "draft",
      issue_date: issueDate,
      due_date: body.dueDate || issueDate,
      subtotal,
      tax,
      total,
      memo: body.memo || "",
      reference_number: body.referenceNumber || "",
      terms: body.terms || "",
    })
    .select("id")
    .single();

  if (error || !doc) return jsonError(error?.message || "Could not create bill", 500);

  await supabase
    .from("teller_document_lines")
    .insert(built.map((line) => ({ ...line, document_id: doc.id })));

  await recordAuditEvent(supabase, {
    organizationId,
    actorId: session.userId,
    action: "bill.created",
    resourceKind: "bill",
    resourceId: doc.id,
    metadata: {
      number,
      total,
      ...(duplicateWarnings.length
        ? {
            duplicateWarningsAcknowledged: true,
            duplicateWarningContext: body.duplicateWarningContext ?? {},
            duplicateWarnings,
          }
        : {}),
    },
  });

  if (body.post !== false) {
    try {
      await submitBillForApproval(supabase, {
        organizationId,
        documentId: doc.id,
        actorId: session.userId,
        accrualAllocations: body.accrualAllocations,
        settlementIdempotencyKey: body.settlementIdempotencyKey,
      });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "Could not submit bill", 400);
    }
  }

  return NextResponse.json({ id: doc.id, number });
}
