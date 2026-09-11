import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { billRequiresApproval, loadApSettings } from "./ap-settings";
import { recordAuditEvent } from "./audit";
import { openBillDocument } from "./tax/posting/open-document";
import { taxLocationFromOrg } from "./tax/posting/location";
import { assertBillStatusTransition } from "./document-transitions";

export async function submitBillForApproval(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    actorId?: string | null;
    accrualAllocations?: Array<{ occurrenceId: string; appliedAmount: number }>;
    settlementIdempotencyKey?: string | null;
  },
) {
  const bill = await loadBill(supabase, input.organizationId, input.documentId);
  if (bill.status !== "draft") throw new Error("Only draft bills can be submitted for approval");

  const settings = await loadApSettings(supabase, input.organizationId);
  const total = asNumber(bill.total);
  const nextStatus = billRequiresApproval(settings, total) ? "pending_approval" : "open";

  if (nextStatus === "pending_approval") {
    assertBillStatusTransition("draft", "pending_approval");
    await supabase
      .from("teller_documents")
      .update({
        status: "pending_approval",
        submitted_by: input.actorId ?? null,
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", input.documentId);

    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "document.status_changed",
      resourceKind: "bill",
      resourceId: input.documentId,
      metadata: { from: "draft", to: "pending_approval", number: bill.number },
    });
    return { status: "pending_approval" as const };
  }

  await approveAndPostBill(supabase, {
    organizationId: input.organizationId,
    documentId: input.documentId,
    bill,
    actorId: input.actorId,
    accrualAllocations: input.accrualAllocations,
    settlementIdempotencyKey: input.settlementIdempotencyKey,
  });
  return { status: "open" as const };
}

export async function approveBill(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    actorId?: string | null;
    accrualAllocations?: Array<{ occurrenceId: string; appliedAmount: number }>;
    settlementIdempotencyKey?: string | null;
  },
) {
  const bill = await loadBill(supabase, input.organizationId, input.documentId);
  if (bill.status !== "pending_approval") {
    throw new Error("Only bills pending approval can be approved");
  }
  if (bill.posted_entry_id) {
    throw new Error("Bill is already posted");
  }

  await approveAndPostBill(supabase, {
    organizationId: input.organizationId,
    documentId: input.documentId,
    bill,
    actorId: input.actorId,
    fromPending: true,
    accrualAllocations: input.accrualAllocations,
    settlementIdempotencyKey: input.settlementIdempotencyKey,
  });
}

export async function rejectBill(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    reason: string;
    actorId?: string | null;
  },
) {
  const bill = await loadBill(supabase, input.organizationId, input.documentId);
  if (bill.status !== "pending_approval") {
    throw new Error("Only bills pending approval can be rejected");
  }
  assertBillStatusTransition("pending_approval", "draft");

  await supabase
    .from("teller_documents")
    .update({
      status: "draft",
      rejection_reason: input.reason.trim(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.documentId);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "document.status_changed",
    resourceKind: "bill",
    resourceId: input.documentId,
    metadata: { from: "pending_approval", to: "draft", reason: input.reason.trim() },
  });
}

async function approveAndPostBill(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    bill: Record<string, unknown>;
    actorId?: string | null;
    fromPending?: boolean;
    accrualAllocations?: Array<{ occurrenceId: string; appliedAmount: number }>;
    settlementIdempotencyKey?: string | null;
  },
) {
  if (input.fromPending) {
    assertBillStatusTransition("pending_approval", "open");
    await supabase
      .from("teller_documents")
      .update({
        approved_by: input.actorId ?? null,
        approved_at: new Date().toISOString(),
        rejection_reason: "",
        updated_at: new Date().toISOString(),
      })
      .eq("id", input.documentId);
  }

  const { data: lines, error: linesError } = await supabase
    .from("teller_document_lines")
    .select(
      "id, amount, account_id, description, job_id, cost_category, cost_type, cost_classification, item_type",
    )
    .eq("document_id", input.documentId);
  if (linesError) throw new Error(linesError.message);
  if (!lines?.length) throw new Error("Bill has no lines to post");

  const { data: org } = await supabase
    .from("teller_organizations")
    .select("country, state, city, county, postal_code")
    .eq("id", input.organizationId)
    .maybeSingle();

  await openBillDocument(supabase, {
    organizationId: input.organizationId,
    documentId: input.documentId,
    partyId: input.bill.party_id as string | null,
    jobId: input.bill.job_id as string | null,
    issueDate: input.bill.issue_date as string,
    number: input.bill.number as string,
    vendorTaxCharged: asNumber(input.bill.tax),
    location: taxLocationFromOrg(org ?? {}),
    lines: (lines ?? []).map((line) => ({
      id: line.id as string,
      amount: asNumber(line.amount),
      account_id: line.account_id as string | null,
      description: line.description as string,
      job_id: line.job_id as string | null,
      cost_category: line.cost_category as string,
      cost_type: line.cost_type as string,
      cost_classification: (line.cost_classification as string) || "direct",
      item_type: line.item_type as string | null,
    })),
    actorId: input.actorId,
    accrualAllocations: input.accrualAllocations,
    settlementIdempotencyKey: input.settlementIdempotencyKey,
  });
}

async function loadBill(
  supabase: SupabaseClient,
  organizationId: string,
  documentId: string,
) {
  const { data, error } = await supabase
    .from("teller_documents")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("kind", "bill")
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Bill not found");
  return data;
}
