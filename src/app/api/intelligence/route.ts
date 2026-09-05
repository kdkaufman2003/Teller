import { NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/accounting/audit";
import { buildIntelligenceReport, buildScanSuggestions } from "@/lib/intelligence/engine";
import { gatherIntelligenceContext, isAiEnabled } from "@/lib/intelligence/signals";
import type { IntelligenceSuggestion } from "@/lib/intelligence/types";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import { parseFiscalYearStart } from "@/lib/org/config";

function mapSuggestion(row: Record<string, unknown>): IntelligenceSuggestion {
  return {
    id: String(row.id),
    kind: row.kind as IntelligenceSuggestion["kind"],
    fingerprint: String(row.fingerprint),
    title: String(row.title),
    description: String(row.description),
    confidence: row.confidence == null ? undefined : Number(row.confidence),
    href: row.href ? String(row.href) : undefined,
    payload:
      row.payload && typeof row.payload === "object"
        ? (row.payload as Record<string, unknown>)
        : undefined,
    resourceKind: row.resource_kind ? String(row.resource_kind) : undefined,
    resourceId: row.resource_id ? String(row.resource_id) : undefined,
  };
}

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const answers = session.settings?.answers ?? {};
  const context = await gatherIntelligenceContext(supabase, {
    organizationId,
    answers,
    fiscalYearStart: parseFiscalYearStart(answers.fiscalYearStart),
  });

  const { data: rows, error } = await supabase
    .from("teller_intelligence_suggestions")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) return jsonError(error.message, 500);

  const report = buildIntelligenceReport({
    context,
    persistedSuggestions: (rows ?? []).map((row) => mapSuggestion(row)),
    aiEnabled: isAiEnabled(),
  });

  return NextResponse.json({ report, context });
}

export async function POST() {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const answers = session.settings?.answers ?? {};
  const context = await gatherIntelligenceContext(supabase, {
    organizationId,
    answers,
    fiscalYearStart: parseFiscalYearStart(answers.fiscalYearStart),
  });

  const scanned = buildScanSuggestions(context);
  if (!scanned.length) {
    const report = buildIntelligenceReport({
      context,
      persistedSuggestions: [],
      aiEnabled: isAiEnabled(),
    });
    return NextResponse.json({ inserted: 0, report });
  }

  const { data: existing } = await supabase
    .from("teller_intelligence_suggestions")
    .select("fingerprint")
    .eq("organization_id", organizationId);
  const known = new Set((existing ?? []).map((row) => row.fingerprint));
  const toInsert = scanned.filter((row) => !known.has(row.fingerprint));

  if (toInsert.length) {
    const { error: insertError } = await supabase.from("teller_intelligence_suggestions").insert(
      toInsert.map((row) => ({
        organization_id: organizationId,
        kind: row.kind,
        status: "pending",
        fingerprint: row.fingerprint,
        title: row.title,
        description: row.description,
        confidence: row.confidence ?? null,
        href: row.href ?? null,
        payload: row.payload ?? {},
        resource_kind: row.resourceKind ?? null,
        resource_id: row.resourceId ?? null,
      })),
    );
    if (insertError) return jsonError(insertError.message, 500);
  }

  await recordAuditEvent(supabase, {
    organizationId,
    actorId: session.userId,
    action: "intelligence.scanned",
    resourceKind: "intelligence_scan",
    metadata: { inserted: toInsert.length, scanned: scanned.length },
  });

  const { data: pending } = await supabase
    .from("teller_intelligence_suggestions")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(20);

  const report = buildIntelligenceReport({
    context,
    persistedSuggestions: (pending ?? []).map((row) => mapSuggestion(row)),
    aiEnabled: isAiEnabled(),
  });

  return NextResponse.json({ inserted: toInsert.length, report });
}
