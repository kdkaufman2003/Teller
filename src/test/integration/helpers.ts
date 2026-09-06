import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { TRADES_ACCOUNTS } from "@/lib/industries/trades-base";

const MINIMAL_ACCOUNT_CODES = new Set(["1000", "1100", "2000", "2300", "4000", "6100", "6150"]);

export function integrationTestsEnabled(): boolean {
  return (
    process.env.RUN_INTEGRATION_TESTS === "1" &&
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()) &&
    Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim())
  );
}

export function createIntegrationClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error("Integration tests require Supabase URL and service role key");
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function createTestOrganization(
  supabase: SupabaseClient,
  label: string,
): Promise<{ organizationId: string; accountIds: Record<string, string> }> {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const { data: org, error: orgError } = await supabase
    .from("teller_organizations")
    .insert({
      name: `Integration Test ${suffix}`,
      legal_name: `Integration Test ${suffix}`,
      industry_id: "hvac-residential",
      setup_completed_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (orgError || !org) throw new Error(orgError?.message || "Could not create test org");

  const seeds = TRADES_ACCOUNTS.filter((row) => MINIMAL_ACCOUNT_CODES.has(row.code));
  const { data: accounts, error: accountsError } = await supabase
    .from("teller_accounts")
    .insert(
      seeds.map((row) => ({
        organization_id: org.id,
        code: row.code,
        name: row.name,
        type: row.type,
        subtype: row.subtype ?? "",
        industry_tag: row.industry_tag ?? "",
        is_system: true,
      })),
    )
    .select("id, code");

  if (accountsError) throw new Error(accountsError.message);

  const accountIds = Object.fromEntries((accounts ?? []).map((row) => [row.code, row.id]));
  return { organizationId: org.id as string, accountIds };
}

export async function deleteTestOrganization(
  supabase: SupabaseClient,
  organizationId: string,
) {
  await supabase.from("teller_organizations").delete().eq("id", organizationId);
}

export async function createTestInvoice(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    revenueAccountId: string;
    total?: number;
    number?: string;
  },
) {
  const total = input.total ?? 1500;
  const { data: doc, error } = await supabase
    .from("teller_documents")
    .insert({
      organization_id: input.organizationId,
      kind: "invoice",
      number: input.number ?? `INV-IT-${Date.now()}`,
      status: "draft",
      issue_date: "2026-04-01",
      due_date: "2026-04-15",
      subtotal: total,
      tax: 0,
      total,
    })
    .select("id, number, total")
    .single();

  if (error || !doc) throw new Error(error?.message || "Could not create invoice");

  await supabase.from("teller_document_lines").insert({
    document_id: doc.id,
    description: "Integration test line",
    quantity: 1,
    unit_price: total,
    amount: total,
    account_id: input.revenueAccountId,
    item_type: "service",
  });

  return doc as { id: string; number: string; total: number };
}

export async function createTestExpenseBill(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    expenseAccountId: string;
    total?: number;
    number?: string;
  },
) {
  const total = input.total ?? 1000;
  const { data: doc, error } = await supabase
    .from("teller_documents")
    .insert({
      organization_id: input.organizationId,
      kind: "expense",
      number: input.number ?? `EXP-IT-${Date.now()}`,
      status: "draft",
      issue_date: "2026-04-01",
      due_date: "2026-04-30",
      subtotal: total,
      tax: 0,
      total,
    })
    .select("id, number, total")
    .single();

  if (error || !doc) throw new Error(error?.message || "Could not create expense");

  await supabase.from("teller_document_lines").insert({
    document_id: doc.id,
    description: "Integration test expense",
    quantity: 1,
    unit_price: total,
    amount: total,
    account_id: input.expenseAccountId,
    item_type: "expense",
  });

  return doc as { id: string; number: string; total: number };
}

export async function createTestBill(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    expenseAccountId: string;
    total?: number;
    number?: string;
    partyId?: string | null;
  },
) {
  const total = input.total ?? 5000;
  const { data: doc, error } = await supabase
    .from("teller_documents")
    .insert({
      organization_id: input.organizationId,
      kind: "bill",
      number: input.number ?? `BILL-IT-${Date.now()}`,
      party_id: input.partyId ?? null,
      status: "draft",
      issue_date: "2026-04-01",
      due_date: "2026-04-30",
      subtotal: total,
      tax: 0,
      total,
    })
    .select("id, number, total")
    .single();

  if (error || !doc) throw new Error(error?.message || "Could not create bill");

  await supabase.from("teller_document_lines").insert({
    document_id: doc.id,
    description: "Integration test bill",
    quantity: 1,
    unit_price: total,
    amount: total,
    account_id: input.expenseAccountId,
    item_type: "expense",
  });

  return doc as { id: string; number: string; total: number };
}

export async function createTestCreditMemo(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    revenueAccountId: string;
    total?: number;
    partyId?: string | null;
    appliesToDocumentId?: string | null;
  },
) {
  const total = input.total ?? 1000;
  const { data: doc, error } = await supabase
    .from("teller_documents")
    .insert({
      organization_id: input.organizationId,
      kind: "credit_memo",
      number: `CM-IT-${Date.now()}`,
      party_id: input.partyId ?? null,
      applies_to_document_id: input.appliesToDocumentId ?? null,
      status: "draft",
      issue_date: "2026-04-01",
      subtotal: total,
      tax: 0,
      total,
    })
    .select("id, number, total")
    .single();

  if (error || !doc) throw new Error(error?.message || "Could not create credit memo");

  await supabase.from("teller_document_lines").insert({
    document_id: doc.id,
    description: "Integration test credit",
    quantity: 1,
    unit_price: total,
    amount: total,
    account_id: input.revenueAccountId,
    item_type: "credit",
  });

  return doc as { id: string; number: string; total: number };
}

export async function createTestVendorCredit(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    expenseAccountId: string;
    total?: number;
    partyId?: string | null;
    appliesToDocumentId?: string | null;
  },
) {
  const total = input.total ?? 500;
  const { data: doc, error } = await supabase
    .from("teller_documents")
    .insert({
      organization_id: input.organizationId,
      kind: "vendor_credit",
      number: `VC-IT-${Date.now()}`,
      party_id: input.partyId ?? null,
      applies_to_document_id: input.appliesToDocumentId ?? null,
      status: "draft",
      issue_date: "2026-04-01",
      subtotal: total,
      tax: 0,
      total,
    })
    .select("id, number, total")
    .single();

  if (error || !doc) throw new Error(error?.message || "Could not create vendor credit");

  await supabase.from("teller_document_lines").insert({
    document_id: doc.id,
    description: "Integration test vendor credit",
    quantity: 1,
    unit_price: total,
    amount: total,
    account_id: input.expenseAccountId,
    item_type: "credit",
  });

  return doc as { id: string; number: string; total: number };
}
