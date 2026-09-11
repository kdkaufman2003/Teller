import type { SupabaseClient } from "@supabase/supabase-js";
import { roundMoney } from "../../payment-fees";
import type { PaginatedReport, TaxAdjustmentReportRow, TaxPaymentReportRow, TaxReportFilters, TaxReportPagination } from "./types";
import { paginateRows } from "./load";

export async function buildTaxPaymentReport(
  supabase: SupabaseClient,
  filters: TaxReportFilters,
  pagination: TaxReportPagination,
): Promise<PaginatedReport<TaxPaymentReportRow>> {
  let query = supabase
    .from("teller_tax_authority_payments")
    .select(
      "id, payment_date, total_amount, base_tax_amount, penalty_amount, interest_amount, reference_number, status, journal_entry_id, registration_id, authority_id, cash_account_id",
    )
    .eq("organization_id", filters.organizationId)
    .order("payment_date", { ascending: false });

  if (filters.startDate) query = query.gte("payment_date", filters.startDate);
  if (filters.endDate) query = query.lte("payment_date", filters.endDate);
  if (filters.registrationId) query = query.eq("registration_id", filters.registrationId);
  if (filters.authorityId) query = query.eq("authority_id", filters.authorityId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const authorityIds = [...new Set((data ?? []).map((row) => row.authority_id).filter(Boolean))] as string[];
  const registrationIds = [...new Set((data ?? []).map((row) => row.registration_id).filter(Boolean))] as string[];
  const accountIds = [...new Set((data ?? []).map((row) => row.cash_account_id).filter(Boolean))] as string[];

  const authorityById = new Map<string, string>();
  if (authorityIds.length) {
    const { data: authorities } = await supabase
      .from("teller_tax_authorities")
      .select("id, name")
      .in("id", authorityIds);
    for (const row of authorities ?? []) authorityById.set(row.id as string, row.name as string);
  }

  const registrationById = new Map<string, string>();
  if (registrationIds.length) {
    const { data: registrations } = await supabase
      .from("teller_tax_registrations")
      .select("id, jurisdiction_key")
      .eq("organization_id", filters.organizationId)
      .in("id", registrationIds);
    for (const row of registrations ?? []) {
      registrationById.set(row.id as string, (row.jurisdiction_key as string | null) ?? "");
    }
  }

  const accountById = new Map<string, string>();
  if (accountIds.length) {
    const { data: accounts } = await supabase
      .from("teller_accounts")
      .select("id, code, name")
      .eq("organization_id", filters.organizationId)
      .in("id", accountIds);
    for (const row of accounts ?? []) {
      accountById.set(row.id as string, `${row.code as string} ${row.name as string}`);
    }
  }

  const rows: TaxPaymentReportRow[] = (data ?? []).map((row) => ({
    paymentDate: row.payment_date as string,
    authorityName: row.authority_id ? authorityById.get(row.authority_id as string) : null,
    registrationJurisdiction: row.registration_id
      ? registrationById.get(row.registration_id as string)
      : null,
    paymentAmount: roundMoney(Number(row.total_amount ?? 0)),
    baseTaxAmount: roundMoney(Number(row.base_tax_amount ?? 0)),
    penaltyAmount: roundMoney(Number(row.penalty_amount ?? 0)),
    interestAmount: roundMoney(Number(row.interest_amount ?? 0)),
    referenceNumber: (row.reference_number as string | null) ?? null,
    bankAccountName: row.cash_account_id ? accountById.get(row.cash_account_id as string) : null,
    journalEntryId: (row.journal_entry_id as string | null) ?? null,
    status: row.status as string,
    paymentId: row.id as string,
  }));

  return paginateRows(rows, pagination);
}

export async function buildTaxAdjustmentReport(
  supabase: SupabaseClient,
  filters: TaxReportFilters,
  pagination: TaxReportPagination,
): Promise<PaginatedReport<TaxAdjustmentReportRow>> {
  let query = supabase
    .from("teller_tax_manual_adjustments")
    .select(
      "id, adjustment_date, direction, reason_code, reason_notes, amount, journal_entry_id, created_by, registration_id, filing_period_id, authority_id, offset_account_id",
    )
    .eq("organization_id", filters.organizationId)
    .order("adjustment_date", { ascending: false });

  if (filters.startDate) query = query.gte("adjustment_date", filters.startDate);
  if (filters.endDate) query = query.lte("adjustment_date", filters.endDate);
  if (filters.registrationId) query = query.eq("registration_id", filters.registrationId);
  if (filters.authorityId) query = query.eq("authority_id", filters.authorityId);
  if (filters.filingPeriodId) query = query.eq("filing_period_id", filters.filingPeriodId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const authorityIds = [...new Set((data ?? []).map((row) => row.authority_id).filter(Boolean))] as string[];
  const registrationIds = [...new Set((data ?? []).map((row) => row.registration_id).filter(Boolean))] as string[];
  const periodIds = [...new Set((data ?? []).map((row) => row.filing_period_id).filter(Boolean))] as string[];
  const accountIds = [...new Set((data ?? []).map((row) => row.offset_account_id).filter(Boolean))] as string[];

  const authorityById = new Map<string, string>();
  if (authorityIds.length) {
    const { data: authorities } = await supabase.from("teller_tax_authorities").select("id, name").in("id", authorityIds);
    for (const row of authorities ?? []) authorityById.set(row.id as string, row.name as string);
  }

  const registrationById = new Map<string, string>();
  if (registrationIds.length) {
    const { data: registrations } = await supabase
      .from("teller_tax_registrations")
      .select("id, jurisdiction_key")
      .eq("organization_id", filters.organizationId)
      .in("id", registrationIds);
    for (const row of registrations ?? []) {
      registrationById.set(row.id as string, (row.jurisdiction_key as string | null) ?? "");
    }
  }

  const periodById = new Map<string, string>();
  if (periodIds.length) {
    const { data: periods } = await supabase
      .from("teller_tax_filing_periods")
      .select("id, period_start, period_end")
      .eq("organization_id", filters.organizationId)
      .in("id", periodIds);
    for (const row of periods ?? []) {
      periodById.set(row.id as string, `${row.period_start}–${row.period_end}`);
    }
  }

  const accountById = new Map<string, string>();
  if (accountIds.length) {
    const { data: accounts } = await supabase
      .from("teller_accounts")
      .select("id, code")
      .eq("organization_id", filters.organizationId)
      .in("id", accountIds);
    for (const row of accounts ?? []) accountById.set(row.id as string, row.code as string);
  }

  const rows: TaxAdjustmentReportRow[] = (data ?? []).map((row) => ({
    adjustmentDate: row.adjustment_date as string,
    authorityName: row.authority_id ? authorityById.get(row.authority_id as string) : null,
    registrationJurisdiction: row.registration_id
      ? registrationById.get(row.registration_id as string)
      : null,
    periodLabel: row.filing_period_id ? periodById.get(row.filing_period_id as string) : null,
    adjustmentType: row.direction as string,
    reason: (row.reason_notes as string | null) ?? (row.reason_code as string | null) ?? null,
    amount: roundMoney(Number(row.amount ?? 0)),
    offsetAccountCode: row.offset_account_id ? accountById.get(row.offset_account_id as string) : null,
    journalEntryId: (row.journal_entry_id as string | null) ?? null,
    createdBy: (row.created_by as string | null) ?? null,
    adjustmentId: row.id as string,
  }));

  return paginateRows(rows, pagination);
}
