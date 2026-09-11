import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import { loadTaxSettings } from "@/lib/accounting/tax/load-tax-settings";
import { taxSettingsToRow } from "@/lib/accounting/tax/settings";
import { assertSameOrganization } from "@/lib/accounting/tax/tenant-isolation";
import type { TaxRoundingPolicy } from "@/lib/accounting/tax/types";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { settings, schemaReady, readiness } = await loadTaxSettings(supabase, organizationId);

  const { data: accounts } = await supabase
    .from("teller_accounts")
    .select("id, code, name, subtype")
    .eq("organization_id", organizationId)
    .in("subtype", ["tax", "sales_tax_payable"])
    .order("code");

  const { data: registrations } = schemaReady
    ? await supabase
        .from("teller_tax_registrations")
        .select("id, jurisdiction_key, authority_id, status, filing_frequency, effective_from, effective_to, metadata")
        .eq("organization_id", organizationId)
        .order("effective_from", { ascending: false })
    : { data: [] };

  return NextResponse.json({
    settings,
    schemaReady,
    readiness,
    liabilityAccounts: accounts ?? [],
    registrations: registrations ?? [],
  });
}

export async function PATCH(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as {
    salesTaxPayableAccountId?: string | null;
    useTaxExpenseAccountId?: string | null;
    roundingPolicy?: TaxRoundingPolicy;
  };

  const current = await loadTaxSettings(supabase, organizationId);
  if (!current.schemaReady) {
    return jsonError("Tax settings schema is not available — apply migration 035 manually first", 503);
  }

  if (body.salesTaxPayableAccountId) {
    const { data: account } = await supabase
      .from("teller_accounts")
      .select("organization_id")
      .eq("id", body.salesTaxPayableAccountId)
      .maybeSingle();
    assertSameOrganization(organizationId, account?.organization_id ?? null, "Sales tax payable account");
  }

  if (body.useTaxExpenseAccountId) {
    const { data: account } = await supabase
      .from("teller_accounts")
      .select("organization_id")
      .eq("id", body.useTaxExpenseAccountId)
      .maybeSingle();
    assertSameOrganization(organizationId, account?.organization_id ?? null, "Use tax expense account");
  }

  const nextSettings = {
    ...current.settings,
    salesTaxPayableAccountId:
      body.salesTaxPayableAccountId !== undefined
        ? body.salesTaxPayableAccountId
        : current.settings.salesTaxPayableAccountId,
    useTaxExpenseAccountId:
      body.useTaxExpenseAccountId !== undefined
        ? body.useTaxExpenseAccountId
        : current.settings.useTaxExpenseAccountId,
    roundingPolicy: body.roundingPolicy ?? current.settings.roundingPolicy,
  };

  const row = taxSettingsToRow(nextSettings, session.userId);
  const { error } = await supabase.from("teller_tax_settings").upsert(row);
  if (error) return jsonError(error.message, 400);

  const reloaded = await loadTaxSettings(supabase, organizationId);
  return NextResponse.json(reloaded);
}
