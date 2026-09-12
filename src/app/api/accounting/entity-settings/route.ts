import { NextResponse } from "next/server";
import {
  ENTITY_METADATA_KEYS,
  loadEntityAccountingSettings,
  upsertEntityAccountingSettings,
  upsertEntityMetadataAccountRefs,
} from "@/lib/accounting/entity-books";
import { jsonError, requireAccountingBooks, requireAccountingWriteBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireAccountingBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, legalEntityId } = ctx;

  const settings = await loadEntityAccountingSettings(supabase, organizationId, legalEntityId);
  return NextResponse.json({ settings, legalEntityId });
}

export async function PATCH(request: Request) {
  const ctx = await requireAccountingWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, legalEntityId } = ctx;

  const body = (await request.json()) as {
    defaultCashAccountId?: string | null;
    defaultArAccountId?: string | null;
    defaultApAccountId?: string | null;
    retainedEarningsAccountId?: string | null;
    customerDepositsAccountId?: string | null;
    fiscalYearStartMonth?: number;
    accountingMethod?: "accrual" | "cash";
    salesTaxPayableAccountId?: string | null;
    useTaxExpenseAccountId?: string | null;
    inventoryAccountMappings?: Array<{ mappingKey: string; accountId: string }>;
  };

  try {
    let settings = await upsertEntityAccountingSettings(supabase, {
      organizationId,
      legalEntityId,
      patch: {
        defaultCashAccountId: body.defaultCashAccountId,
        defaultArAccountId: body.defaultArAccountId,
        defaultApAccountId: body.defaultApAccountId,
        retainedEarningsAccountId: body.retainedEarningsAccountId,
        customerDepositsAccountId: body.customerDepositsAccountId,
        fiscalYearStartMonth: body.fiscalYearStartMonth,
        accountingMethod: body.accountingMethod,
      },
    });

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
    if (body.inventoryAccountMappings !== undefined) {
      metadataPatch[ENTITY_METADATA_KEYS.inventoryMappings] = body.inventoryAccountMappings;
      accountIds.push(...body.inventoryAccountMappings.map((row) => row.accountId));
    }

    if (Object.keys(metadataPatch).length) {
      settings = await upsertEntityMetadataAccountRefs(supabase, {
        organizationId,
        legalEntityId,
        metadataPatch,
        accountIdsToValidate: accountIds,
      });
    }

    return NextResponse.json({ settings, legalEntityId });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not update entity settings", 400);
  }
}
