import { NextResponse } from "next/server";
import {
  ENTITY_METADATA_KEYS,
  loadEntityAccountingSettings,
  upsertEntityMetadataAccountRefs,
} from "@/lib/accounting/entity-books";
import { jsonError, requireAccountingBooks, requireAccountingWriteBooks } from "@/lib/api";
import { loadTaxSettings } from "@/lib/accounting/tax/load-tax-settings";
import { taxSettingsToRow } from "@/lib/accounting/tax/settings";
import type { TaxRoundingPolicy } from "@/lib/accounting/tax/types";

export async function GET() {
  const ctx = await requireAccountingBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, legalEntityId } = ctx;

  const { settings, schemaReady, readiness } = await loadTaxSettings(supabase, organizationId);
  const entitySettings = await loadEntityAccountingSettings(supabase, organizationId, legalEntityId);
  const entityTaxAccounts = {
    salesTaxPayableAccountId:
      (entitySettings?.metadata[ENTITY_METADATA_KEYS.salesTaxPayableAccountId] as string | null) ??
      null,
    useTaxExpenseAccountId:
      (entitySettings?.metadata[ENTITY_METADATA_KEYS.useTaxExpenseAccountId] as string | null) ??
      null,
  };

  const { data: accounts } = await supabase
    .from("teller_accounts")
    .select("id, code, name, subtype")
    .eq("organization_id", organizationId)
    .eq("legal_entity_id", legalEntityId)
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
    settings: { ...settings, ...entityTaxAccounts },
    schemaReady,
    readiness,
    liabilityAccounts: accounts ?? [],
    registrations: registrations ?? [],
    legalEntityId,
  });
}

export async function PATCH(request: Request) {
  const ctx = await requireAccountingWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, legalEntityId, session } = ctx;

  const body = (await request.json()) as {
    salesTaxPayableAccountId?: string | null;
    useTaxExpenseAccountId?: string | null;
    roundingPolicy?: TaxRoundingPolicy;
  };

  const current = await loadTaxSettings(supabase, organizationId);
  if (!current.schemaReady) {
    return jsonError("Tax settings schema is not available — apply migration 035 manually first", 503);
  }

  if (
    body.salesTaxPayableAccountId !== undefined ||
    body.useTaxExpenseAccountId !== undefined
  ) {
    const metadataPatch: Record<string, unknown> = {};
    const accountIds: Array<string | null | undefined> = [];
    if (body.salesTaxPayableAccountId !== undefined) {
      metadataPatch[ENTITY_METADATA_KEYS.salesTaxPayableAccountId] = body.salesTaxPayableAccountId;
      accountIds.push(body.salesTaxPayableAccountId);
    }
    if (body.useTaxExpenseAccountId !== undefined) {
      metadataPatch[ENTITY_METADATA_KEYS.useTaxExpenseAccountId] = body.useTaxExpenseAccountId;
      accountIds.push(body.useTaxExpenseAccountId);
    }
    try {
      await upsertEntityMetadataAccountRefs(supabase, {
        organizationId,
        legalEntityId,
        metadataPatch,
        accountIdsToValidate: accountIds,
      });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "Invalid tax account", 400);
    }
  }

  const nextSettings = {
    ...current.settings,
    roundingPolicy: body.roundingPolicy ?? current.settings.roundingPolicy,
  };

  const row = taxSettingsToRow(nextSettings, session.userId);
  const { error } = await supabase.from("teller_tax_settings").upsert(row);
  if (error) return jsonError(error.message, 400);

  const reloaded = await loadTaxSettings(supabase, organizationId);
  const entitySettings = await loadEntityAccountingSettings(supabase, organizationId, legalEntityId);
  return NextResponse.json({
    ...reloaded,
    settings: {
      ...reloaded.settings,
      salesTaxPayableAccountId:
        (entitySettings?.metadata[ENTITY_METADATA_KEYS.salesTaxPayableAccountId] as string | null) ??
        null,
      useTaxExpenseAccountId:
        (entitySettings?.metadata[ENTITY_METADATA_KEYS.useTaxExpenseAccountId] as string | null) ??
        null,
    },
    legalEntityId,
  });
}
