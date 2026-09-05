import { NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/accounting/audit";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import {
  parseAccountingBasis,
  parseFiscalYearStart,
  resolveOrgTaxRate,
} from "@/lib/org/config";

const ACCOUNTING_ANSWER_KEYS = ["basis", "fiscalYearStart", "taxRate", "collectTax", "taxMode"] as const;

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const [{ data: org }, { data: settings }, { data: locations }] = await Promise.all([
    supabase.from("teller_organizations").select("*").eq("id", organizationId).maybeSingle(),
    supabase
      .from("teller_industry_settings")
      .select("answers, modules, labels")
      .eq("organization_id", organizationId)
      .maybeSingle(),
    supabase
      .from("teller_locations")
      .select("*")
      .eq("organization_id", organizationId)
      .order("is_primary", { ascending: false })
      .order("name"),
  ]);

  if (!org) return jsonError("Organization not found", 404);

  return NextResponse.json({
    organization: org,
    settings: settings ?? { answers: {}, modules: [], labels: {} },
    locations: locations ?? [],
  });
}

export async function PATCH(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as {
    organization?: {
      name?: string;
      legal_name?: string;
      phone?: string;
      timezone?: string;
      currency?: string;
      address_line1?: string;
      address_line2?: string;
      city?: string;
      state?: string;
      postal_code?: string;
      country?: string;
    };
    answers?: Record<string, unknown>;
  };

  const orgPatch = body.organization ?? {};
  const orgUpdate: Record<string, string> = {
    updated_at: new Date().toISOString(),
  };

  if (orgPatch.name !== undefined) {
    const name = String(orgPatch.name).trim();
    if (!name) return jsonError("Company name is required");
    orgUpdate.name = name;
  }
  if (orgPatch.legal_name !== undefined) orgUpdate.legal_name = String(orgPatch.legal_name).trim();
  if (orgPatch.phone !== undefined) orgUpdate.phone = String(orgPatch.phone).trim();
  if (orgPatch.timezone !== undefined) orgUpdate.timezone = String(orgPatch.timezone).trim();
  if (orgPatch.currency !== undefined) orgUpdate.currency = String(orgPatch.currency).trim().toUpperCase();
  if (orgPatch.address_line1 !== undefined) orgUpdate.address_line1 = String(orgPatch.address_line1).trim();
  if (orgPatch.address_line2 !== undefined) orgUpdate.address_line2 = String(orgPatch.address_line2).trim();
  if (orgPatch.city !== undefined) orgUpdate.city = String(orgPatch.city).trim();
  if (orgPatch.state !== undefined) orgUpdate.state = String(orgPatch.state).trim();
  if (orgPatch.postal_code !== undefined) orgUpdate.postal_code = String(orgPatch.postal_code).trim();
  if (orgPatch.country !== undefined) orgUpdate.country = String(orgPatch.country).trim().toUpperCase();

  if (Object.keys(orgUpdate).length > 1) {
    const { error } = await supabase
      .from("teller_organizations")
      .update(orgUpdate)
      .eq("id", organizationId);
    if (error) return jsonError(error.message, 500);
  }

  if (body.answers) {
    const { data: existing } = await supabase
      .from("teller_industry_settings")
      .select("answers")
      .eq("organization_id", organizationId)
      .maybeSingle();

    const currentAnswers =
      existing?.answers && typeof existing.answers === "object"
        ? (existing.answers as Record<string, unknown>)
        : {};

    const nextAnswers = { ...currentAnswers };
    for (const key of ACCOUNTING_ANSWER_KEYS) {
      if (body.answers[key] !== undefined) {
        nextAnswers[key] = body.answers[key];
      }
    }

    if (nextAnswers.basis !== undefined) {
      nextAnswers.basis = parseAccountingBasis(nextAnswers.basis);
    }
    if (nextAnswers.fiscalYearStart !== undefined) {
      nextAnswers.fiscalYearStart = String(parseFiscalYearStart(nextAnswers.fiscalYearStart));
    }
    if (nextAnswers.taxRate !== undefined) {
      nextAnswers.taxRate = Math.max(0, Number(nextAnswers.taxRate) || 0);
    }
    if (nextAnswers.collectTax !== undefined) {
      nextAnswers.collectTax =
        nextAnswers.collectTax === true ||
        nextAnswers.collectTax === "true" ||
        nextAnswers.collectTax === "yes";
    }

    const { error } = await supabase
      .from("teller_industry_settings")
      .update({ answers: nextAnswers, updated_at: new Date().toISOString() })
      .eq("organization_id", organizationId);
    if (error) return jsonError(error.message, 500);

    await recordAuditEvent(supabase, {
      organizationId,
      actorId: session.userId,
      action: "settings.updated",
      resourceKind: "org_settings",
      resourceId: organizationId,
      metadata: {
        type: "accounting_config",
        basis: nextAnswers.basis,
        fiscalYearStart: nextAnswers.fiscalYearStart,
        taxRate: resolveOrgTaxRate(nextAnswers),
        collectTax: nextAnswers.collectTax,
      },
    });
  }

  if (Object.keys(orgUpdate).length > 1) {
    await recordAuditEvent(supabase, {
      organizationId,
      actorId: session.userId,
      action: "settings.updated",
      resourceKind: "org_settings",
      resourceId: organizationId,
      metadata: { type: "company_profile", fields: Object.keys(orgPatch) },
    });
  }

  return NextResponse.json({ ok: true });
}
