import { NextResponse } from "next/server";
import { enrichDocumentsWithAuthoritativePaid } from "@/lib/accounting/balances";
import { recordAuditEvent } from "@/lib/accounting/audit";
import { runFinancialIntegrityChecks } from "@/lib/accounting/integrity";
import { auditLegacyPayments } from "@/lib/accounting/legacy-payments";
import { reconcileSubledgersToGl } from "@/lib/accounting/subledger";
import { jsonError, requireAdminBooks } from "@/lib/api";

/** Read-only integrity and legacy payment audit for owners/admins. */
export async function GET(request: Request) {
  const ctx = await requireAdminBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const url = new URL(request.url);
  const includeLegacyAudit = url.searchParams.get("legacyAudit") === "1";

  const [integrityIssues, subledger] = await Promise.all([
    runFinancialIntegrityChecks(supabase, organizationId),
    reconcileSubledgersToGl(supabase, organizationId),
  ]);

  await recordAuditEvent(supabase, {
    organizationId,
    actorId: ctx.session.userId,
    action: "subledger.integrity_checked",
    resourceKind: "organization",
    resourceId: organizationId,
    metadata: {
      issueCount: integrityIssues.length,
      subledgerConsistent: subledger.every((row) => row.consistent),
    },
  });

  const payload: Record<string, unknown> = {
    integrityIssues,
    subledgerReconciliation: subledger,
    issueCount: integrityIssues.length,
  };

  if (includeLegacyAudit) {
    payload.legacyPaymentAudit = await auditLegacyPayments(supabase, organizationId);
  }

  return NextResponse.json(payload);
}

export async function POST() {
  return jsonError("Integrity checks are read-only", 405);
}
