import { NextResponse } from "next/server";
import { runFinancialIntegrityChecks } from "@/lib/accounting/integrity";
import { auditLegacyPayments, reconcileSubledgerToControl } from "@/lib/accounting/legacy-payments";
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
    reconcileSubledgerToControl(supabase, organizationId),
  ]);

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
