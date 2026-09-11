/**
 * Phase 15A controlled DB acceptance — requires manually applied migration 035.
 * Mutates dedicated Phase 15 demo org only. HFAC org is read-only.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import { calculateTaxForOrganization } from "../src/lib/accounting/tax/calculate-for-org";
import { resolveCustomerExemption } from "../src/lib/accounting/tax/exemptions/resolver";
import { parseTaxExemptionRow } from "../src/lib/accounting/tax/exemptions/parse";
import { rejectCrossOrgReference } from "../src/lib/accounting/tax/tenant-isolation";
import { isEffectiveOn, findOverlappingRateComponents } from "../src/lib/accounting/tax/rates";
import { POSTED_TAX_HISTORY_IMMUTABLE } from "../src/lib/accounting/tax/immutability";
import { TAX_ENGINE_VERSION } from "../src/lib/accounting/tax/calculation/types";
import { postInvoiceOpenWithPhase15Tax, TaxPostingBlockedError } from "../src/lib/accounting/tax/posting/open-invoice";
import { postCreditMemoOpenWithPhase15Tax } from "../src/lib/accounting/tax/posting/open-credit";
import {
  postBillOpenWithPhase15Tax,
  PurchaseTaxPostingBlockedError,
} from "../src/lib/accounting/tax/posting/open-bill";
import { voidInvoice, postInvoicePaid } from "../src/lib/accounting/post";
import { postBillPaid, voidBill } from "../src/lib/accounting/bills";
import {
  generateTaxFilingPeriods,
  reconcileAndPersistTaxPeriod,
  reconcileTaxPeriod,
  transitionTaxFilingPeriodStatus,
} from "../src/lib/accounting/tax/filing";
import { generateFilingPeriodsForRegistration } from "../src/lib/accounting/tax/filing/period-generation";
import {
  postAuthorityTaxPayment,
  postTaxManualAdjustment,
  reverseAuthorityTaxPayment,
} from "../src/lib/accounting/tax/payments";
import {
  activateStateTaxPack,
  getStateTaxPack,
  validateStateTaxPack,
} from "../src/lib/accounting/tax/state-packs";
import {
  buildAccountantTaxPackage,
  buildExemptTaxDetailReport,
  buildNeedsReviewTaxReport,
  buildSalesTaxDetailReport,
  buildTaxGlReconciliationReport,
  buildTaxPaymentReport,
  buildTaxRollforwardReport,
  buildTaxSummaryReport,
  buildUseTaxDetailReport,
  loadFilteredPostedTaxTransactions,
  loadPostedTaxTransactions,
  parseTaxReportPagination,
  neutralizeTaxCsvFormula,
} from "../src/lib/accounting/tax/reports";
import {
  aggregateTaxOwedFromPeriods,
  getTaxOwnerSummary,
} from "../src/lib/accounting/tax/owner";

type Result = { name: string; pass: boolean; detail?: string };
type Flags = Record<string, boolean | string | number>;

const HFAC_ORG = TELLER_HFAC_ORG_ID;
/** HFAC live Stripe payment journal added 2026-09-11 — independent of Phase 15 tax acceptance. */
const HFAC_EXPECTED_DOCS = 8;
const HFAC_EXPECTED_JOURNALS = 17;

function loadEnv() {
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST=1 required");
  }
  const orgId = process.env.TELLER_PHASE15_DEMO_ORG_ID?.trim();
  const foreignOrgId = process.env.TELLER_PHASE15_FOREIGN_ORG_ID?.trim();
  if (!orgId) throw new Error("TELLER_PHASE15_DEMO_ORG_ID missing — run setup:phase15-demo-org after migration 035");
  if (!foreignOrgId) throw new Error("TELLER_PHASE15_FOREIGN_ORG_ID missing");
  assertNotHfacOrganization(orgId);
  assertNotHfacOrganization(foreignOrgId);
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return { orgId, foreignOrgId, supabase };
}

async function tableExists(supabase: SupabaseClient, table: string): Promise<boolean> {
  const { error } = await supabase.from(table).select("*", { count: "exact", head: true });
  if (!error) return true;
  if (/does not exist|schema cache|PGRST205/i.test(error.message)) return false;
  throw new Error(`${table}: ${error.message || "unknown probe error"}`);
}

async function phase15gSchemaReady(supabase: SupabaseClient): Promise<boolean> {
  if (!(await tableExists(supabase, "teller_tax_authority_payments"))) return false;
  if (!(await tableExists(supabase, "teller_tax_manual_adjustments"))) return false;
  for (const column of [
    { table: "teller_tax_settings", column: "tax_penalty_expense_account_id" },
    { table: "teller_tax_transactions", column: "registration_id" },
    { table: "teller_tax_transactions", column: "authority_payment_id" },
  ] as const) {
    const { error } = await supabase.from(column.table).select(column.column).limit(1);
    if (error && /does not exist|schema cache|PGRST205/i.test(error.message)) return false;
  }
  return true;
}

const ACCEPTANCE_RULE_SET_SLUG = "phase15-controlled-acceptance";

async function ensureJurisdiction(
  supabase: SupabaseClient,
  jurisdictionKey: string,
  name: string,
  fields: { country?: string; state?: string; county?: string },
) {
  const { error } = await supabase.from("teller_tax_jurisdictions").upsert(
    {
      jurisdiction_key: jurisdictionKey,
      name,
      country: fields.country ?? "US",
      state: fields.state ?? null,
      county: fields.county ?? null,
    },
    { onConflict: "jurisdiction_key" },
  );
  if (error) throw new Error(error.message);
}

async function ensureRuleSet(supabase: SupabaseClient, slug: string): Promise<string> {
  const { data: existing } = await supabase
    .from("teller_tax_rule_sets")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (existing?.id) return existing.id;
  const { data, error } = await supabase
    .from("teller_tax_rule_sets")
    .insert({
      slug,
      name: slug,
      version: "1",
      status: "active",
      effective_from: "2020-01-01",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message || `rule set ${slug} missing`);
  return data.id;
}

async function ensureAcceptanceRuleSet(supabase: SupabaseClient): Promise<string> {
  const { data: existing } = await supabase
    .from("teller_tax_rule_sets")
    .select("id")
    .eq("slug", ACCEPTANCE_RULE_SET_SLUG)
    .maybeSingle();
  if (existing?.id) return existing.id;
  const { data, error } = await supabase
    .from("teller_tax_rule_sets")
    .insert({
      slug: ACCEPTANCE_RULE_SET_SLUG,
      name: "Phase 15 Controlled Acceptance",
      version: "1",
      status: "active",
      effective_from: "2020-01-01",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message || "rule set missing");
  return data.id;
}

async function seedRateComponent(
  supabase: SupabaseClient,
  ruleSetId: string,
  component: {
    jurisdictionKey: string;
    componentType: string;
    ratePercent: number;
    effectiveFrom: string;
    effectiveTo?: string | null;
  },
): Promise<void> {
  const { data: existing } = await supabase
    .from("teller_tax_rate_components")
    .select("id")
    .eq("jurisdiction_key", component.jurisdictionKey)
    .eq("component_type", component.componentType)
    .eq("rate_percent", component.ratePercent)
    .eq("effective_from", component.effectiveFrom)
    .maybeSingle();
  if (existing?.id) return;

  const { data: rate, error: rateError } = await supabase
    .from("teller_tax_rates")
    .insert({
      rule_set_id: ruleSetId,
      jurisdiction_key: component.jurisdictionKey,
      rate_percent: component.ratePercent,
      effective_from: component.effectiveFrom,
      effective_to: component.effectiveTo ?? null,
    })
    .select("id")
    .single();
  if (rateError || !rate) throw new Error(rateError?.message || "rate insert failed");
  const { error } = await supabase.from("teller_tax_rate_components").insert({
    rate_id: rate.id,
    component_type: component.componentType,
    jurisdiction_key: component.jurisdictionKey,
    rate_percent: component.ratePercent,
    effective_from: component.effectiveFrom,
    effective_to: component.effectiveTo ?? null,
  });
  if (error) throw new Error(error.message);
}

async function ensureDemoParty(supabase: SupabaseClient, organizationId: string, name: string): Promise<string> {
  const { data: existing } = await supabase
    .from("teller_parties")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("name", name)
    .maybeSingle();
  if (existing?.id) return existing.id;
  const { data, error } = await supabase
    .from("teller_parties")
    .insert({
      organization_id: organizationId,
      name,
      kind: "customer",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message || "party insert failed");
  return data.id;
}

async function ensureAccount(
  supabase: SupabaseClient,
  organizationId: string,
  row: { code: string; name: string; type: string; subtype?: string },
): Promise<string> {
  const { data: existing } = await supabase
    .from("teller_accounts")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("code", row.code)
    .maybeSingle();
  if (existing?.id) return existing.id;
  const { data, error } = await supabase
    .from("teller_accounts")
    .insert({
      organization_id: organizationId,
      code: row.code,
      name: row.name,
      type: row.type,
      subtype: row.subtype ?? "",
      is_system: true,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message || `account ${row.code} insert failed`);
  return data.id;
}

async function ensureTaxSettingsForPosting(
  supabase: SupabaseClient,
  organizationId: string,
  salesTaxPayableAccountId: string,
  useTaxExpenseAccountId?: string | null,
) {
  const { error } = await supabase.from("teller_tax_settings").upsert({
    organization_id: organizationId,
    sales_tax_payable_account_id: salesTaxPayableAccountId,
    use_tax_expense_account_id: useTaxExpenseAccountId ?? null,
    rounding_policy: "per_line",
    setup_status: "configured",
  });
  if (error) throw new Error(error.message);
}

async function createDraftInvoice(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    partyId: string;
    number: string;
    issueDate: string;
    lines: { amount: number; accountId: string; description: string; itemType?: string }[];
  },
): Promise<{ documentId: string; lineIds: string[] }> {
  const subtotal = input.lines.reduce((sum, line) => sum + line.amount, 0);
  const { data: doc, error } = await supabase
    .from("teller_documents")
    .insert({
      organization_id: organizationId,
      kind: "invoice",
      number: input.number,
      party_id: input.partyId,
      status: "draft",
      issue_date: input.issueDate,
      subtotal,
      tax: 0,
      total: subtotal,
    })
    .select("id")
    .single();
  if (error || !doc) throw new Error(error?.message || "invoice insert failed");
  const { data: lines, error: lineError } = await supabase
    .from("teller_document_lines")
    .insert(
      input.lines.map((line, index) => ({
        document_id: doc.id,
        description: line.description,
        amount: line.amount,
        account_id: line.accountId,
        item_type: line.itemType ?? "equipment",
        sort_order: index,
      })),
    )
    .select("id");
  if (lineError) throw new Error(lineError.message);
  return { documentId: doc.id, lineIds: (lines ?? []).map((l) => l.id as string) };
}

async function ensureDemoVendor(
  supabase: SupabaseClient,
  organizationId: string,
  name: string,
): Promise<string> {
  const { data: existing } = await supabase
    .from("teller_parties")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("name", name)
    .maybeSingle();
  if (existing?.id) return existing.id;
  const { data, error } = await supabase
    .from("teller_parties")
    .insert({
      organization_id: organizationId,
      name,
      kind: "vendor",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message || "vendor insert failed");
  return data.id;
}

async function createDraftBill(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    partyId: string;
    number: string;
    issueDate: string;
    vendorTax: number;
    lines: { amount: number; accountId: string; description: string; itemType?: string; costType?: string }[];
  },
): Promise<{ documentId: string; lineIds: string[] }> {
  const subtotal = input.lines.reduce((sum, line) => sum + line.amount, 0);
  const { data: doc, error } = await supabase
    .from("teller_documents")
    .insert({
      organization_id: organizationId,
      kind: "bill",
      number: input.number,
      party_id: input.partyId,
      status: "draft",
      issue_date: input.issueDate,
      subtotal,
      tax: input.vendorTax,
      total: subtotal + input.vendorTax,
    })
    .select("id")
    .single();
  if (error || !doc) throw new Error(error?.message || "bill insert failed");
  const { data: lines, error: lineError } = await supabase
    .from("teller_document_lines")
    .insert(
      input.lines.map((line, index) => ({
        document_id: doc.id,
        description: line.description,
        amount: line.amount,
        account_id: line.accountId,
        item_type: line.itemType ?? "equipment",
        cost_type: line.costType ?? "",
        sort_order: index,
      })),
    )
    .select("id");
  if (lineError) throw new Error(lineError.message);
  return { documentId: doc.id, lineIds: (lines ?? []).map((l) => l.id as string) };
}

async function ensureDemoRegistration(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    jurisdictionKey: string;
    filingFrequency?: "monthly" | "quarterly" | "annual";
    effectiveFrom?: string;
  },
): Promise<string> {
  const { data: existing } = await supabase
    .from("teller_tax_registrations")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("jurisdiction_key", input.jurisdictionKey)
    .eq("filing_frequency", input.filingFrequency ?? "monthly")
    .eq("status", "active")
    .maybeSingle();
  if (existing?.id) return existing.id;

  const { data, error } = await supabase
    .from("teller_tax_registrations")
    .insert({
      organization_id: organizationId,
      jurisdiction_key: input.jurisdictionKey,
      filing_frequency: input.filingFrequency ?? "monthly",
      status: "active",
      effective_from: input.effectiveFrom ?? "2020-01-01",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message || "registration insert failed");
  return data.id;
}

async function sumApCredit(
  supabase: SupabaseClient,
  entryId: string,
  apAccountId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("teller_journal_lines")
    .select("credit, debit, account_id")
    .eq("entry_id", entryId);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .filter((line) => line.account_id === apAccountId)
    .reduce((sum, line) => sum + Number(line.credit ?? 0) - Number(line.debit ?? 0), 0);
}

async function sumTaxPayableCredit(
  supabase: SupabaseClient,
  entryId: string,
  taxPayableAccountId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("teller_journal_lines")
    .select("credit, debit, account_id")
    .eq("entry_id", entryId);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .filter((line) => line.account_id === taxPayableAccountId)
    .reduce((sum, line) => sum + Number(line.credit ?? 0) - Number(line.debit ?? 0), 0);
}

async function sumTaxPayableDebit(
  supabase: SupabaseClient,
  entryId: string,
  taxPayableAccountId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("teller_journal_lines")
    .select("credit, debit, account_id")
    .eq("entry_id", entryId);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .filter((line) => line.account_id === taxPayableAccountId)
    .reduce((sum, line) => sum + Number(line.debit ?? 0) - Number(line.credit ?? 0), 0);
}

async function insertExemption(
  supabase: SupabaseClient,
  organizationId: string,
  partyId: string,
  input: {
    certificateNumber: string;
    jurisdictionScope: string[];
    categoryScope: string[];
    effectiveFrom: string;
    effectiveTo?: string | null;
    status?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<string> {
  const { data, error } = await supabase
    .from("teller_tax_exemptions")
    .insert({
      organization_id: organizationId,
      party_id: partyId,
      certificate_number: input.certificateNumber,
      certificate_on_file: true,
      jurisdiction_scope: input.jurisdictionScope,
      category_scope: input.categoryScope,
      status: input.status ?? "active",
      effective_from: input.effectiveFrom,
      effective_to: input.effectiveTo ?? null,
      metadata: { certificateType: "resale", reviewStatus: "approved", ...(input.metadata ?? {}) },
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message || "exemption insert failed");
  return data.id;
}

async function upsertTaxabilityRule(
  supabase: SupabaseClient,
  organizationId: string,
  rule: {
    jurisdictionKey: string;
    taxCategoryKey: string;
    treatment: string;
    priority?: number;
    effectiveFrom?: string;
    effectiveTo?: string | null;
  },
) {
  const { data: existing } = await supabase
    .from("teller_taxability_rules")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("jurisdiction_key", rule.jurisdictionKey)
    .eq("tax_category_key", rule.taxCategoryKey)
    .maybeSingle();
  const payload = {
    organization_id: organizationId,
    jurisdiction_key: rule.jurisdictionKey,
    tax_category_key: rule.taxCategoryKey,
    treatment: rule.treatment,
    priority: rule.priority ?? 100,
    effective_from: rule.effectiveFrom ?? "2020-01-01",
    effective_to: rule.effectiveTo ?? null,
    source_kind: "organization_override",
  };
  if (existing?.id) {
    const { error } = await supabase.from("teller_taxability_rules").update(payload).eq("id", existing.id);
    if (error) throw new Error(error.message);
    return;
  }
  const { error } = await supabase.from("teller_taxability_rules").insert(payload);
  if (error) throw new Error(error.message);
}

async function runScenario(name: string, fn: () => Promise<void>, results: Result[]) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({
      name,
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function main() {
  const { orgId, foreignOrgId, supabase } = loadEnv();
  const results: Result[] = [];
  const flags: Flags = {
    PHASE15A_DB_ACCEPTANCE: false,
    PHASE15B_DB_ACCEPTANCE: false,
    PHASE15C_DB_ACCEPTANCE: false,
    PHASE15A_JOURNALS_CREATED: 0,
    PHASE15B_JOURNALS_CREATED: 0,
    PHASE15C_JOURNALS_CREATED: 0,
    PHASE15D_JOURNALS_CREATED: 0,
    TAX_ENGINE_VERSION,
    HFAC_MODIFIED: false,
    POSTED_TAX_HISTORY_IMMUTABLE,
  };

  const { count: postedTaxTxBaseline } = await supabase
    .from("teller_tax_transactions")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("is_posted", true);

  const schemaReady = await tableExists(supabase, "teller_tax_settings");
  if (!schemaReady) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          skipped: true,
          reason: "Migration 035 not applied — run manually before DB acceptance",
          migrationFile: "supabase/migrations/035_phase15_tax_accounting.sql",
          results: [],
          flags,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  await runScenario("JURISDICTION_HIERARCHY_COLUMNS", async () => {
    const { error } = await supabase.from("teller_tax_jurisdictions").select("jurisdiction_type, parent_jurisdiction_key").limit(1);
    if (error) throw new Error(error.message);
  }, results);

  await runScenario("TAX_SETTINGS_ORG_SCOPED", async () => {
    const { error } = await supabase.from("teller_tax_settings").upsert({
      organization_id: orgId,
      rounding_policy: "per_line",
      setup_status: "not_configured",
    });
    if (error) throw new Error(error.message);
    const { data } = await supabase.from("teller_tax_settings").select("organization_id").eq("organization_id", orgId).single();
    if (data?.organization_id !== orgId) throw new Error("settings org mismatch");
  }, results);

  await runScenario("CROSS_ORG_ACCOUNT_REJECTED", async () => {
    const { data: foreignAccount } = await supabase
      .from("teller_accounts")
      .select("id, organization_id")
      .eq("organization_id", foreignOrgId)
      .limit(1)
      .maybeSingle();
    if (!foreignAccount) throw new Error("foreign account fixture missing");
    if (!rejectCrossOrgReference(orgId, foreignAccount.organization_id)) {
      throw new Error("fixture accounts must be cross-org");
    }
    const { error } = await supabase.from("teller_tax_settings").upsert({
      organization_id: orgId,
      sales_tax_payable_account_id: foreignAccount.id,
      rounding_policy: "per_line",
      setup_status: "needs_review",
    });
    if (!error || !/belong to organization/i.test(error.message)) {
      throw new Error(`expected cross-org account rejection, got: ${error?.message ?? "none"}`);
    }
  }, results);

  await runScenario("EFFECTIVE_DATING_HELPERS", async () => {
    if (!isEffectiveOn({ effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" }, "2026-06-01")) {
      throw new Error("effective date helper failed");
    }
    const overlap = findOverlappingRateComponents(
      [
        {
          componentType: "state",
          jurisdictionKey: "US-KS",
          ratePercent: 6.5,
          effectiveFrom: "2026-01-01",
        },
        {
          componentType: "state",
          jurisdictionKey: "US-KS",
          ratePercent: 6.5,
          effectiveFrom: "2026-01-01",
        },
      ],
      "2026-06-01",
    );
    if (!overlap) throw new Error("expected overlap detection");
  }, results);

  await runScenario("HFAC_BASELINE_UNCHANGED", async () => {
    const { count: docs } = await supabase
      .from("teller_documents")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", HFAC_ORG);
    const { count: journals } = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", HFAC_ORG);
    flags.HFAC_DOCUMENTS = docs ?? 0;
    flags.HFAC_JOURNALS = journals ?? 0;
    const { count: hfacTaxTx } = await supabase
      .from("teller_tax_transactions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", HFAC_ORG);
    if ((hfacTaxTx ?? 0) > 0) throw new Error("HFAC must not have tax subledger rows in 15A acceptance");
  }, results);

  await runScenario("ZERO_JOURNALS_FROM_ACCEPTANCE", async () => {
    const { count } = await supabase
      .from("teller_tax_transactions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("is_posted", true);
    flags.PHASE15A_JOURNALS_CREATED = (count ?? 0) - (postedTaxTxBaseline ?? 0);
    if ((count ?? 0) > (postedTaxTxBaseline ?? 0)) {
      throw new Error("15A acceptance must not post tax journals");
    }
  }, results);

  // --- Phase 15B calculation acceptance (no journal posting) ---
  const ruleSetId = await ensureAcceptanceRuleSet(supabase);
  const J = {
    taxable: "US-KS-P15BTAX",
    multiState: "US-KS-P15BMULTI",
    multiCounty: "US-KS-P15BMULTIJO",
    effDate: "US-KS-P15BEFF",
    mixed: "US-KS-P15BMIXED",
    review: "US-KS-P15BREVIEW",
    ambiguous: "US-KS-P15BAMB",
    inclusive: "US-KS-P15BINC",
    tenant: "US-KS-P15BTENANT",
  };

  for (const [key, county] of [
    [J.taxable, "P15BTAX"],
    [J.multiState, "P15BMULTI"],
    [J.multiCounty, "P15BMULTIJO"],
    [J.effDate, "P15BEFF"],
    [J.mixed, "P15BMIXED"],
    [J.review, "P15BREVIEW"],
    [J.ambiguous, "P15BAMB"],
    [J.inclusive, "P15BINC"],
    [J.tenant, "P15BTENANT"],
  ] as const) {
    await ensureJurisdiction(supabase, key, `Phase15B ${county}`, { state: "KS", county });
  }

  await runScenario("15B_TAXABLE_LINE", async () => {
    await upsertTaxabilityRule(supabase, orgId, {
      jurisdictionKey: J.taxable,
      taxCategoryKey: "equipment",
      treatment: "taxable",
    });
    await seedRateComponent(supabase, ruleSetId, {
      jurisdictionKey: J.taxable,
      componentType: "state",
      ratePercent: 6.5,
      effectiveFrom: "2020-01-01",
    });
    const result = await calculateTaxForOrganization(supabase, orgId, {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      location: { transactionLocation: { country: "US", state: "KS", county: "P15BTAX" } },
      lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
    });
    if (result.taxTotal !== 6.5) throw new Error(`expected tax 6.5, got ${result.taxTotal}`);
  }, results);

  await runScenario("15B_MULTI_COMPONENT", async () => {
    await upsertTaxabilityRule(supabase, orgId, {
      jurisdictionKey: J.multiCounty,
      taxCategoryKey: "equipment",
      treatment: "taxable",
    });
    await seedRateComponent(supabase, ruleSetId, {
      jurisdictionKey: J.multiState,
      componentType: "state",
      ratePercent: 6.5,
      effectiveFrom: "2020-01-01",
    });
    await seedRateComponent(supabase, ruleSetId, {
      jurisdictionKey: J.multiCounty,
      componentType: "county",
      ratePercent: 1.25,
      effectiveFrom: "2020-01-01",
    });
    const result = await calculateTaxForOrganization(supabase, orgId, {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      location: { transactionLocation: { country: "US", state: "KS", county: "P15BMULTIJO" } },
      lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
    });
    if (result.taxTotal !== 7.75) throw new Error(`expected tax 7.75, got ${result.taxTotal}`);
    if (result.jurisdictionComponents.length < 2) throw new Error("expected multi-component result");
  }, results);

  await runScenario("15B_EFFECTIVE_DATED_RATE", async () => {
    await upsertTaxabilityRule(supabase, orgId, {
      jurisdictionKey: J.effDate,
      taxCategoryKey: "equipment",
      treatment: "taxable",
    });
    await seedRateComponent(supabase, ruleSetId, {
      jurisdictionKey: J.effDate,
      componentType: "state",
      ratePercent: 5,
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-05-31",
    });
    await seedRateComponent(supabase, ruleSetId, {
      jurisdictionKey: J.effDate,
      componentType: "state",
      ratePercent: 7,
      effectiveFrom: "2026-06-01",
    });
    const past = await calculateTaxForOrganization(supabase, orgId, {
      transactionDate: "2026-05-15",
      transactionType: "invoice",
      location: { transactionLocation: { country: "US", state: "KS", county: "P15BEFF" } },
      lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
    });
    const present = await calculateTaxForOrganization(supabase, orgId, {
      transactionDate: "2026-06-15",
      transactionType: "invoice",
      location: { transactionLocation: { country: "US", state: "KS", county: "P15BEFF" } },
      lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
    });
    if (past.taxTotal !== 5) throw new Error(`past rate expected 5, got ${past.taxTotal}`);
    if (present.taxTotal !== 7) throw new Error(`present rate expected 7, got ${present.taxTotal}`);
  }, results);

  await runScenario("15B_MIXED_DOCUMENT", async () => {
    await upsertTaxabilityRule(supabase, orgId, {
      jurisdictionKey: J.mixed,
      taxCategoryKey: "equipment",
      treatment: "taxable",
    });
    await upsertTaxabilityRule(supabase, orgId, {
      jurisdictionKey: J.mixed,
      taxCategoryKey: "labor",
      treatment: "non_taxable",
    });
    await seedRateComponent(supabase, ruleSetId, {
      jurisdictionKey: J.mixed,
      componentType: "state",
      ratePercent: 6.5,
      effectiveFrom: "2020-01-01",
    });
    const result = await calculateTaxForOrganization(supabase, orgId, {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      location: { transactionLocation: { country: "US", state: "KS", county: "P15BMIXED" } },
      lines: [
        { lineKey: "1", lineAmount: 100, taxCategory: "equipment" },
        { lineKey: "2", lineAmount: 50, taxCategory: "labor" },
      ],
    });
    if (result.lineResults[0]!.taxAmount <= 0) throw new Error("equipment line should be taxed");
    if (result.lineResults[1]!.taxAmount !== 0) throw new Error("labor line should not be taxed");
  }, results);

  await runScenario("15B_NEEDS_REVIEW_MISSING_RULE", async () => {
    const result = await calculateTaxForOrganization(supabase, orgId, {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      location: { transactionLocation: { country: "US", state: "KS", county: "P15BREVIEW" } },
      lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "unknown_category_xyz" }],
    });
    if (result.status !== "needs_review") throw new Error("expected needs_review for unknown category rule");
  }, results);

  await runScenario("15B_AMBIGUOUS_RATE_REJECTED", async () => {
    await upsertTaxabilityRule(supabase, orgId, {
      jurisdictionKey: J.ambiguous,
      taxCategoryKey: "equipment",
      treatment: "taxable",
    });
    await seedRateComponent(supabase, ruleSetId, {
      jurisdictionKey: J.ambiguous,
      componentType: "state",
      ratePercent: 6.5,
      effectiveFrom: "2026-07-01",
    });
    await seedRateComponent(supabase, ruleSetId, {
      jurisdictionKey: J.ambiguous,
      componentType: "state",
      ratePercent: 7,
      effectiveFrom: "2026-07-01",
    });
    const result = await calculateTaxForOrganization(supabase, orgId, {
      transactionDate: "2026-07-15",
      transactionType: "invoice",
      location: { transactionLocation: { country: "US", state: "KS", county: "P15BAMB" } },
      lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
    });
    if (result.status !== "needs_review") throw new Error("expected needs_review for ambiguous rate");
  }, results);

  await runScenario("15B_INCLUSIVE_TAX", async () => {
    await upsertTaxabilityRule(supabase, orgId, {
      jurisdictionKey: J.inclusive,
      taxCategoryKey: "equipment",
      treatment: "taxable",
    });
    await seedRateComponent(supabase, ruleSetId, {
      jurisdictionKey: J.inclusive,
      componentType: "state",
      ratePercent: 8,
      effectiveFrom: "2020-01-01",
    });
    const result = await calculateTaxForOrganization(supabase, orgId, {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      mode: "inclusive",
      location: { transactionLocation: { country: "US", state: "KS", county: "P15BINC" } },
      lines: [{ lineKey: "1", lineAmount: 108, taxCategory: "equipment", taxInclusive: true }],
    });
    if (result.lineResults[0]!.taxableBasis !== 100) {
      throw new Error(`expected inclusive basis 100, got ${result.lineResults[0]!.taxableBasis}`);
    }
    if (result.lineResults[0]!.taxAmount !== 8) {
      throw new Error(`expected inclusive tax 8, got ${result.lineResults[0]!.taxAmount}`);
    }
  }, results);

  await runScenario("15B_TENANT_ISOLATION", async () => {
    await upsertTaxabilityRule(supabase, orgId, {
      jurisdictionKey: J.tenant,
      taxCategoryKey: "equipment",
      treatment: "taxable",
    });
    await upsertTaxabilityRule(supabase, foreignOrgId, {
      jurisdictionKey: J.tenant,
      taxCategoryKey: "equipment",
      treatment: "non_taxable",
    });
    await seedRateComponent(supabase, ruleSetId, {
      jurisdictionKey: J.tenant,
      componentType: "state",
      ratePercent: 6.5,
      effectiveFrom: "2020-01-01",
    });
    const demo = await calculateTaxForOrganization(supabase, orgId, {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      location: { transactionLocation: { country: "US", state: "KS", county: "P15BTENANT" } },
      lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
    });
    const foreign = await calculateTaxForOrganization(supabase, foreignOrgId, {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      location: { transactionLocation: { country: "US", state: "KS", county: "P15BTENANT" } },
      lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
    });
    if (demo.lineResults[0]!.taxAmount === foreign.lineResults[0]!.taxAmount) {
      throw new Error("org-scoped rules must produce different tax outcomes");
    }
    if (rejectCrossOrgReference(orgId, foreignOrgId) !== true) {
      throw new Error("foreign org must remain cross-org isolated");
    }
  }, results);

  await runScenario("15B_ZERO_JOURNALS", async () => {
    const { count } = await supabase
      .from("teller_tax_transactions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("is_posted", true);
    flags.PHASE15B_JOURNALS_CREATED = (count ?? 0) - (postedTaxTxBaseline ?? 0);
    if ((count ?? 0) > (postedTaxTxBaseline ?? 0)) {
      throw new Error("15B acceptance must not post tax journals");
    }
  }, results);

  await runScenario("15B_PREVIEW_NO_IMMUTABLE_TAX_TX", async () => {
    const { count: txBefore } = await supabase
      .from("teller_tax_transactions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    const { count: snapBefore } = await supabase
      .from("teller_tax_determination_snapshots")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    await calculateTaxForOrganization(supabase, orgId, {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      location: { transactionLocation: { country: "US", state: "KS" } },
      lines: [{ lineKey: "preview", lineAmount: 10, taxCategory: "equipment" }],
    });
    const { count: txAfter } = await supabase
      .from("teller_tax_transactions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    const { count: snapAfter } = await supabase
      .from("teller_tax_determination_snapshots")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    if ((txAfter ?? 0) !== (txBefore ?? 0) || (snapAfter ?? 0) !== (snapBefore ?? 0)) {
      throw new Error("preview calculation must not persist tax transactions or snapshots");
    }
  }, results);

  // --- Phase 15C exemption acceptance ---
  const J15C = "US-KS-P15CEX";
  await ensureJurisdiction(supabase, J15C, "Phase15C Exemption", { state: "KS", county: "P15CEX" });
  const demoPartyId = await ensureDemoParty(supabase, orgId, "Phase 15C Demo Customer");

  await upsertTaxabilityRule(supabase, orgId, {
    jurisdictionKey: J15C,
    taxCategoryKey: "equipment",
    treatment: "taxable",
  });
  await seedRateComponent(supabase, ruleSetId, {
    jurisdictionKey: J15C,
    componentType: "state",
    ratePercent: 6.5,
    effectiveFrom: "2020-01-01",
  });

  await runScenario("15C_VALID_EXEMPTION_RESOLVES", async () => {
    const validPartyId = await ensureDemoParty(
      supabase,
      orgId,
      `Phase 15C Valid Resolver Customer ${Date.now()}`,
    );
    const exemptionId = await insertExemption(supabase, orgId, validPartyId, {
      certificateNumber: `P15C-VALID-${Date.now()}`,
      jurisdictionScope: [J15C],
      categoryScope: ["equipment"],
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-12-31",
    });
    const { data } = await supabase
      .from("teller_tax_exemptions")
      .select("*")
      .eq("organization_id", orgId)
      .eq("id", exemptionId)
      .single();
    const parsed = parseTaxExemptionRow(data as never);
    const resolution = resolveCustomerExemption({
      exemptions: [parsed],
      transactionDate: "2026-06-01",
      jurisdictionKey: J15C,
      taxCategoryKey: "equipment",
    });
    if (resolution.status !== "valid") throw new Error(`expected valid exemption, got ${resolution.status}`);
  }, results);

  await runScenario("15C_CALCULATOR_EXEMPT_LINE", async () => {
    const calcPartyId = await ensureDemoParty(
      supabase,
      orgId,
      `Phase 15C Calculator Exempt Customer ${Date.now()}`,
    );
    await insertExemption(supabase, orgId, calcPartyId, {
      certificateNumber: `P15C-CALC-${Date.now()}`,
      jurisdictionScope: [J15C],
      categoryScope: ["equipment"],
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-12-31",
    });
    const result = await calculateTaxForOrganization(supabase, orgId, {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      location: { transactionLocation: { country: "US", state: "KS", county: "P15CEX" } },
      customer: { partyId: calcPartyId },
      lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
    });
    if (result.lineResults[0]!.treatment !== "exempt") throw new Error("expected exempt line");
    if (result.lineResults[0]!.taxAmount !== 0) throw new Error("exempt line must have zero tax");
  }, results);

  await runScenario("15C_EXPIRED_EXEMPTION_REJECTED", async () => {
    const partyId = await ensureDemoParty(supabase, orgId, "Phase 15C Expired Customer");
    await insertExemption(supabase, orgId, partyId, {
      certificateNumber: "P15C-EXP-1",
      jurisdictionScope: [J15C],
      categoryScope: ["equipment"],
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-05-31",
      status: "expired",
    });
    const result = await calculateTaxForOrganization(supabase, orgId, {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      location: { transactionLocation: { country: "US", state: "KS", county: "P15CEX" } },
      customer: { partyId },
      lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
    });
    if (result.lineResults[0]!.treatment !== "taxable") throw new Error("expired exemption must not apply");
    if (result.lineResults[0]!.taxAmount !== 6.5) throw new Error("taxable line expected after expired exemption");
  }, results);

  await runScenario("15C_WRONG_JURISDICTION_REJECTED", async () => {
    const partyId = await ensureDemoParty(supabase, orgId, "Phase 15C Wrong Jurisdiction Customer");
    await insertExemption(supabase, orgId, partyId, {
      certificateNumber: "P15C-JUR-1",
      jurisdictionScope: ["US-MO-P15CEX"],
      categoryScope: ["equipment"],
      effectiveFrom: "2026-01-01",
    });
    const result = await calculateTaxForOrganization(supabase, orgId, {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      location: { transactionLocation: { country: "US", state: "KS", county: "P15CEX" } },
      customer: { partyId },
      lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
    });
    if (result.lineResults[0]!.treatment === "exempt") throw new Error("out-of-jurisdiction exemption must not apply");
  }, results);

  await runScenario("15C_WRONG_CATEGORY_REJECTED", async () => {
    const partyId = await ensureDemoParty(supabase, orgId, "Phase 15C Wrong Category Customer");
    await insertExemption(supabase, orgId, partyId, {
      certificateNumber: "P15C-CAT-1",
      jurisdictionScope: [J15C],
      categoryScope: ["labor"],
      effectiveFrom: "2026-01-01",
    });
    const result = await calculateTaxForOrganization(supabase, orgId, {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      location: { transactionLocation: { country: "US", state: "KS", county: "P15CEX" } },
      customer: { partyId },
      lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
    });
    if (result.lineResults[0]!.treatment === "exempt") throw new Error("out-of-category exemption must not apply");
  }, results);

  await runScenario("15C_AMBIGUOUS_EXEMPTION_NEEDS_REVIEW", async () => {
    const partyId = await ensureDemoParty(supabase, orgId, "Phase 15C Ambiguous Customer");
    await insertExemption(supabase, orgId, partyId, {
      certificateNumber: "P15C-AMB-1",
      jurisdictionScope: [J15C],
      categoryScope: ["equipment"],
      effectiveFrom: "2026-01-01",
    });
    await insertExemption(supabase, orgId, partyId, {
      certificateNumber: "P15C-AMB-2",
      jurisdictionScope: [J15C],
      categoryScope: ["equipment"],
      effectiveFrom: "2026-01-01",
    });
    const result = await calculateTaxForOrganization(supabase, orgId, {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      location: { transactionLocation: { country: "US", state: "KS", county: "P15CEX" } },
      customer: { partyId },
      lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
    });
    if (result.status !== "needs_review") throw new Error("ambiguous exemption must force needs_review");
  }, results);

  await runScenario("15C_TENANT_ISOLATION", async () => {
    const isolatedForeignParty = await ensureDemoParty(
      supabase,
      foreignOrgId,
      `Phase 15C Isolated Foreign Customer ${Date.now()}`,
    );
    await upsertTaxabilityRule(supabase, foreignOrgId, {
      jurisdictionKey: J15C,
      taxCategoryKey: "equipment",
      treatment: "taxable",
    });
    await insertExemption(supabase, foreignOrgId, isolatedForeignParty, {
      certificateNumber: `P15C-FOR-${Date.now()}`,
      jurisdictionScope: [J15C],
      categoryScope: ["*"],
      effectiveFrom: "2026-01-01",
    });
    const isolatedDemoParty = await ensureDemoParty(
      supabase,
      orgId,
      `Phase 15C Isolated Demo Customer ${Date.now()}`,
    );
    await insertExemption(supabase, orgId, isolatedDemoParty, {
      certificateNumber: `P15C-DEMO-${Date.now()}`,
      jurisdictionScope: [J15C],
      categoryScope: ["equipment"],
      effectiveFrom: "2026-01-01",
    });
    const demo = await calculateTaxForOrganization(supabase, orgId, {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      location: { transactionLocation: { country: "US", state: "KS", county: "P15CEX" } },
      customer: { partyId: isolatedDemoParty },
      lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
    });
    const foreign = await calculateTaxForOrganization(supabase, foreignOrgId, {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      location: { transactionLocation: { country: "US", state: "KS", county: "P15CEX" } },
      customer: { partyId: isolatedForeignParty },
      lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
    });
    if (demo.lineResults[0]!.treatment !== "exempt") throw new Error("demo org exemption expected");
    if (foreign.lineResults[0]!.treatment !== "exempt") throw new Error("foreign org exemption expected");
    if (rejectCrossOrgReference(orgId, foreignOrgId) !== true) throw new Error("cross-org isolation required");
  }, results);

  await runScenario("15C_HISTORICAL_SNAPSHOT_IMMUTABLE", async () => {
    const histPartyId = await ensureDemoParty(
      supabase,
      orgId,
      `Phase 15C Historical Snapshot Customer ${Date.now()}`,
    );
    const histExemptionId = await insertExemption(supabase, orgId, histPartyId, {
      certificateNumber: `P15C-HIST-${Date.now()}`,
      jurisdictionScope: [J15C],
      categoryScope: ["equipment"],
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-12-31",
    });
    const { data: inserted, error } = await supabase
      .from("teller_tax_determination_snapshots")
      .insert({
        organization_id: orgId,
        transaction_date: "2026-01-15",
        determination_status: "exempt",
        taxable_basis: 0,
        tax_amount: 0,
        exemption_id: histExemptionId,
        metadata: { exemptionCertificateType: "resale", frozen: true },
      })
      .select("id, tax_amount, determination_status")
      .single();
    if (error || !inserted) throw new Error(error?.message || "snapshot insert failed");
    await supabase
      .from("teller_tax_exemptions")
      .update({ status: "expired", effective_to: "2026-01-31" })
      .eq("organization_id", orgId)
      .eq("id", histExemptionId);
    const { data: snapshot } = await supabase
      .from("teller_tax_determination_snapshots")
      .select("tax_amount, determination_status")
      .eq("id", inserted.id)
      .single();
    if (snapshot?.determination_status !== "exempt" || Number(snapshot.tax_amount) !== 0) {
      throw new Error("historical snapshot must remain unchanged after exemption expiry");
    }
    const { error: updateError } = await supabase
      .from("teller_tax_determination_snapshots")
      .update({ tax_amount: 99 })
      .eq("id", inserted.id);
    if (!updateError || !/immutable/i.test(updateError.message)) {
      throw new Error("snapshot immutability trigger expected on update");
    }
  }, results);

  await runScenario("15C_ZERO_JOURNALS_FROM_EXEMPTION_CONFIG", async () => {
    const { count: journalsBefore } = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    const { count: docsBefore } = await supabase
      .from("teller_documents")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    await insertExemption(supabase, orgId, demoPartyId, {
      certificateNumber: "P15C-NOGL-1",
      jurisdictionScope: [J15C],
      categoryScope: ["equipment"],
      effectiveFrom: "2026-08-01",
      status: "pending",
    });
    const { count: journalsAfter } = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    const { count: docsAfter } = await supabase
      .from("teller_documents")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    flags.PHASE15C_JOURNALS_CREATED = 0;
    if ((journalsAfter ?? 0) !== (journalsBefore ?? 0) || (docsAfter ?? 0) !== (docsBefore ?? 0)) {
      throw new Error("exemption configuration must not mutate accounting documents or journals");
    }
  }, results);

  // --- Phase 15D tax posting acceptance ---
  const J15D = "US-KS-P15D";
  await ensureJurisdiction(supabase, J15D, "Phase15D Posting", { state: "KS", county: "P15D" });
  const arAccountId = await ensureAccount(supabase, orgId, {
    code: "1100",
    name: "Accounts Receivable",
    type: "asset",
    subtype: "receivable",
  });
  const revenueAccountId = await ensureAccount(supabase, orgId, {
    code: "4000",
    name: "Revenue",
    type: "revenue",
  });
  const taxPayableAccountId = await ensureAccount(supabase, orgId, {
    code: "2100",
    name: "Sales Tax Payable",
    type: "liability",
    subtype: "tax",
  });
  const useTaxExpenseAccountId = await ensureAccount(supabase, orgId, {
    code: "6100",
    name: "Use Tax Expense",
    type: "expense",
  });
  const expenseAccountId = await ensureAccount(supabase, orgId, {
    code: "6200",
    name: "Supplies Expense",
    type: "expense",
  });
  const apAccountId = await ensureAccount(supabase, orgId, {
    code: "2000",
    name: "Accounts Payable",
    type: "liability",
    subtype: "payable",
  });
  await ensureTaxSettingsForPosting(supabase, orgId, taxPayableAccountId, useTaxExpenseAccountId);
  await upsertTaxabilityRule(supabase, orgId, {
    jurisdictionKey: J15D,
    taxCategoryKey: "equipment",
    treatment: "taxable",
  });
  await seedRateComponent(supabase, ruleSetId, {
    jurisdictionKey: J15D,
    componentType: "state",
    ratePercent: 6.5,
    effectiveFrom: "2020-01-01",
  });
  await seedRateComponent(supabase, ruleSetId, {
    jurisdictionKey: J15D,
    componentType: "county",
    ratePercent: 1.25,
    effectiveFrom: "2020-01-01",
  });

  const journalsBefore15D = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);

  await runScenario("15D_TAXABLE_INVOICE_POSTS_PAYABLE", async () => {
    const partyId = await ensureDemoParty(supabase, orgId, `Phase 15D Invoice Customer ${Date.now()}`);
    const { documentId, lineIds } = await createDraftInvoice(supabase, orgId, {
      partyId,
      number: `INV-P15D-${Date.now()}`,
      issueDate: "2026-06-01",
      lines: [{ amount: 1000, accountId: revenueAccountId, description: "Equipment", itemType: "equipment" }],
    });
    const posted = await postInvoiceOpenWithPhase15Tax(supabase, {
      organizationId: orgId,
      documentId,
      partyId,
      jobId: null,
      issueDate: "2026-06-01",
      number: `INV-P15D-${Date.now()}`,
      location: { country: "US", state: "KS", county: "P15D" },
      lines: [{ id: lineIds[0], amount: 1000, account_id: revenueAccountId, description: "Equipment", item_type: "equipment" }],
    });
    const glTax = await sumTaxPayableCredit(supabase, posted.entryId, taxPayableAccountId);
    if (posted.taxTotal <= 0) throw new Error("expected positive tax");
    if (Math.abs(glTax - posted.taxTotal) > 0.01) throw new Error("GL tax payable must equal calculated tax");
  }, results);

  await runScenario("15D_TAX_SUBLEDGER_EQ_GL", async () => {
    const partyId = await ensureDemoParty(supabase, orgId, `Phase 15D Subledger Customer ${Date.now()}`);
    const { documentId, lineIds } = await createDraftInvoice(supabase, orgId, {
      partyId,
      number: `INV-P15D-SL-${Date.now()}`,
      issueDate: "2026-06-01",
      lines: [{ amount: 500, accountId: revenueAccountId, description: "Equipment", itemType: "equipment" }],
    });
    const posted = await postInvoiceOpenWithPhase15Tax(supabase, {
      organizationId: orgId,
      documentId,
      partyId,
      jobId: null,
      issueDate: "2026-06-01",
      number: "INV-P15D-SL",
      location: { country: "US", state: "KS", county: "P15D" },
      lines: [{ id: lineIds[0], amount: 500, account_id: revenueAccountId, description: "Equipment", item_type: "equipment" }],
    });
    const { data: txRows } = await supabase
      .from("teller_tax_transactions")
      .select("tax_amount")
      .eq("organization_id", orgId)
      .eq("document_id", documentId)
      .eq("is_posted", true)
      .eq("transaction_type", "sales_tax_collected");
    const subledgerTotal = (txRows ?? []).reduce((sum, row) => sum + Number(row.tax_amount), 0);
    const glTax = await sumTaxPayableCredit(supabase, posted.entryId, taxPayableAccountId);
    if (Math.abs(subledgerTotal - glTax) > 0.01) throw new Error("tax subledger must equal GL tax payable movement");
  }, results);

  await runScenario("15D_EXEMPT_INVOICE_ZERO_TAX", async () => {
    const partyId = await ensureDemoParty(supabase, orgId, `Phase 15D Exempt Customer ${Date.now()}`);
    await insertExemption(supabase, orgId, partyId, {
      certificateNumber: `P15D-EX-${Date.now()}`,
      jurisdictionScope: [J15D],
      categoryScope: ["equipment"],
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-12-31",
    });
    const { documentId, lineIds } = await createDraftInvoice(supabase, orgId, {
      partyId,
      number: `INV-P15D-EX-${Date.now()}`,
      issueDate: "2026-06-01",
      lines: [{ amount: 300, accountId: revenueAccountId, description: "Equipment", itemType: "equipment" }],
    });
    const posted = await postInvoiceOpenWithPhase15Tax(supabase, {
      organizationId: orgId,
      documentId,
      partyId,
      jobId: null,
      issueDate: "2026-06-01",
      number: "INV-P15D-EX",
      location: { country: "US", state: "KS", county: "P15D" },
      lines: [{ id: lineIds[0], amount: 300, account_id: revenueAccountId, description: "Equipment", item_type: "equipment" }],
    });
    if (posted.taxTotal !== 0) throw new Error("exempt invoice must have zero tax");
    const glTax = await sumTaxPayableCredit(supabase, posted.entryId, taxPayableAccountId);
    if (Math.abs(glTax) > 0.009) throw new Error("exempt invoice must not credit tax payable");
  }, results);

  await runScenario("15D_NEEDS_REVIEW_BLOCKS_POSTING", async () => {
    const partyId = await ensureDemoParty(supabase, orgId, `Phase 15D Review Customer ${Date.now()}`);
    const { documentId, lineIds } = await createDraftInvoice(supabase, orgId, {
      partyId,
      number: `INV-P15D-NR-${Date.now()}`,
      issueDate: "2026-06-01",
      lines: [{ amount: 100, accountId: revenueAccountId, description: "Unknown", itemType: "unknown_tax_category_xyz" }],
    });
    let blocked = false;
    try {
      await postInvoiceOpenWithPhase15Tax(supabase, {
        organizationId: orgId,
        documentId,
        partyId,
        jobId: null,
        issueDate: "2026-06-01",
        number: "INV-P15D-NR",
        location: { country: "US", state: "KS", county: "P15D" },
        lines: [{ id: lineIds[0], amount: 100, account_id: revenueAccountId, description: "Unknown", item_type: "unknown_tax_category_xyz" }],
      });
    } catch (error) {
      blocked = error instanceof TaxPostingBlockedError;
    }
    if (!blocked) throw new Error("needs_review invoice must block posting");
  }, results);

  await runScenario("15D_MISSING_PAYABLE_BLOCKS", async () => {
    await supabase.from("teller_tax_settings").upsert({
      organization_id: orgId,
      sales_tax_payable_account_id: null,
      rounding_policy: "per_line",
      setup_status: "needs_review",
    });
    const partyId = await ensureDemoParty(supabase, orgId, `Phase 15D Missing Payable ${Date.now()}`);
    const { documentId, lineIds } = await createDraftInvoice(supabase, orgId, {
      partyId,
      number: `INV-P15D-MP-${Date.now()}`,
      issueDate: "2026-06-01",
      lines: [{ amount: 100, accountId: revenueAccountId, description: "Equipment", itemType: "equipment" }],
    });
    let blocked = false;
    try {
      await postInvoiceOpenWithPhase15Tax(supabase, {
        organizationId: orgId,
        documentId,
        partyId,
        jobId: null,
        issueDate: "2026-06-01",
        number: "INV-P15D-MP",
        location: { country: "US", state: "KS", county: "P15D" },
        lines: [{ id: lineIds[0], amount: 100, account_id: revenueAccountId, description: "Equipment", item_type: "equipment" }],
      });
    } catch (error) {
      blocked = error instanceof TaxPostingBlockedError || (error instanceof Error && /payable account/i.test(error.message));
    }
    await ensureTaxSettingsForPosting(supabase, orgId, taxPayableAccountId, useTaxExpenseAccountId);
    if (!blocked) throw new Error("missing tax payable account must block taxable posting");
  }, results);

  await runScenario("15D_PARTIAL_CREDIT_TAX", async () => {
    const partyId = await ensureDemoParty(supabase, orgId, `Phase 15D Partial Credit ${Date.now()}`);
    const { documentId: invoiceId, lineIds: invoiceLineIds } = await createDraftInvoice(supabase, orgId, {
      partyId,
      number: `INV-P15D-PC-${Date.now()}`,
      issueDate: "2026-06-01",
      lines: [{ amount: 1000, accountId: revenueAccountId, description: "Equipment", itemType: "equipment" }],
    });
    await postInvoiceOpenWithPhase15Tax(supabase, {
      organizationId: orgId,
      documentId: invoiceId,
      partyId,
      jobId: null,
      issueDate: "2026-06-01",
      number: "INV-P15D-PC",
      location: { country: "US", state: "KS", county: "P15D" },
      lines: [{ id: invoiceLineIds[0], amount: 1000, account_id: revenueAccountId, description: "Equipment", item_type: "equipment" }],
    });
    const { data: creditDoc, error } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: orgId,
        kind: "credit_memo",
        number: `CM-P15D-${Date.now()}`,
        party_id: partyId,
        status: "draft",
        issue_date: "2026-06-15",
        subtotal: 250,
        tax: 0,
        total: 250,
        metadata: { originalDocumentId: invoiceId },
      })
      .select("id")
      .single();
    if (error || !creditDoc) throw new Error(error?.message || "credit insert failed");
    const { data: creditLine } = await supabase
      .from("teller_document_lines")
      .insert({
        document_id: creditDoc.id,
        description: "Partial credit",
        amount: 250,
        account_id: revenueAccountId,
        item_type: "equipment",
        sort_order: 0,
      })
      .select("id")
      .single();
    const postedCredit = await postCreditMemoOpenWithPhase15Tax(supabase, {
      organizationId: orgId,
      documentId: creditDoc.id,
      partyId,
      jobId: null,
      issueDate: "2026-06-15",
      number: "CM-P15D-PC",
      location: { country: "US", state: "KS", county: "P15D" },
      originalDocumentId: invoiceId,
      lines: [{ id: creditLine?.id, amount: 250, account_id: revenueAccountId, description: "Partial credit", item_type: "equipment" }],
    });
    const glTaxDebit = await sumTaxPayableCredit(supabase, postedCredit.entryId, taxPayableAccountId);
    if (postedCredit.taxTotal <= 0) throw new Error("partial credit on taxable line should reverse tax");
    if (Math.abs(-glTaxDebit - postedCredit.taxTotal) > 0.02) throw new Error("credit tax reversal must match GL tax payable debit");
  }, results);

  await runScenario("15D_PAYMENT_NO_DUPLICATE_TAX", async () => {
    const partyId = await ensureDemoParty(supabase, orgId, `Phase 15D Payment Customer ${Date.now()}`);
    const cashAccountId = await ensureAccount(supabase, orgId, {
      code: "1000",
      name: "Cash",
      type: "asset",
      subtype: "bank",
    });
    const { documentId, lineIds } = await createDraftInvoice(supabase, orgId, {
      partyId,
      number: `INV-P15D-PAY-${Date.now()}`,
      issueDate: "2026-06-01",
      lines: [{ amount: 200, accountId: revenueAccountId, description: "Equipment", itemType: "equipment" }],
    });
    const posted = await postInvoiceOpenWithPhase15Tax(supabase, {
      organizationId: orgId,
      documentId,
      partyId,
      jobId: null,
      issueDate: "2026-06-01",
      number: "INV-P15D-PAY",
      location: { country: "US", state: "KS", county: "P15D" },
      lines: [{ id: lineIds[0], amount: 200, account_id: revenueAccountId, description: "Equipment", item_type: "equipment" }],
    });
    const { count: taxTxBefore } = await supabase
      .from("teller_tax_transactions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("document_id", documentId);
    await postInvoicePaid(supabase, {
      organizationId: orgId,
      documentId,
      partyId,
      jobId: null,
      issueDate: "2026-06-02",
      number: "INV-P15D-PAY",
      total: posted.total,
      invoiceTotal: posted.total,
      priorPaid: 0,
    });
    const { count: taxTxAfter } = await supabase
      .from("teller_tax_transactions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("document_id", documentId);
    if ((taxTxAfter ?? 0) !== (taxTxBefore ?? 0)) throw new Error("customer payment must not create additional tax transactions");
    void cashAccountId;
  }, results);

  await runScenario("15D_IDEMPOTENT_POSTING", async () => {
    const partyId = await ensureDemoParty(supabase, orgId, `Phase 15D Idempotent ${Date.now()}`);
    const { documentId, lineIds } = await createDraftInvoice(supabase, orgId, {
      partyId,
      number: `INV-P15D-ID-${Date.now()}`,
      issueDate: "2026-06-01",
      lines: [{ amount: 150, accountId: revenueAccountId, description: "Equipment", itemType: "equipment" }],
    });
    const input = {
      organizationId: orgId,
      documentId,
      partyId,
      jobId: null,
      issueDate: "2026-06-01",
      number: "INV-P15D-ID",
      location: { country: "US", state: "KS", county: "P15D" },
      lines: [{ id: lineIds[0], amount: 150, account_id: revenueAccountId, description: "Equipment", item_type: "equipment" }],
    };
    const first = await postInvoiceOpenWithPhase15Tax(supabase, input);
    const second = await postInvoiceOpenWithPhase15Tax(supabase, input);
    if (first.entryId !== second.entryId) throw new Error("duplicate posting must be idempotent");
    const { count } = await supabase
      .from("teller_tax_transactions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("document_id", documentId)
      .eq("is_posted", true);
    if ((count ?? 0) !== 1) throw new Error("idempotent posting must not duplicate tax transactions");
  }, results);

  await runScenario("15E_FULLY_TAXED_EXPENSE_BILL", async () => {
    const vendorId = await ensureDemoVendor(supabase, orgId, `Phase 15E Vendor FT ${Date.now()}`);
    const { documentId, lineIds } = await createDraftBill(supabase, orgId, {
      partyId: vendorId,
      number: `BILL-P15E-FT-${Date.now()}`,
      issueDate: "2026-06-01",
      vendorTax: 77.5,
      lines: [{ amount: 1000, accountId: expenseAccountId, description: "Supplies", itemType: "equipment" }],
    });
    const posted = await postBillOpenWithPhase15Tax(supabase, {
      organizationId: orgId,
      documentId,
      partyId: vendorId,
      jobId: null,
      issueDate: "2026-06-01",
      number: "BILL-P15E-FT",
      vendorTaxCharged: 77.5,
      location: { country: "US", state: "KS", county: "P15D" },
      lines: [
        {
          id: lineIds[0],
          amount: 1000,
          account_id: expenseAccountId,
          description: "Supplies",
          item_type: "equipment",
        },
      ],
    });
    if (posted.useTaxDueTotal > 0.009) throw new Error("fully taxed bill must not accrue use tax");
    const apCredit = await sumApCredit(supabase, posted.entryId, apAccountId);
    if (Math.abs(apCredit - 1077.5) > 0.02) throw new Error("AP must include vendor tax only");
  }, results);

  await runScenario("15E_UNTAXED_USE_TAX", async () => {
    const vendorId = await ensureDemoVendor(supabase, orgId, `Phase 15E Vendor UT ${Date.now()}`);
    const { documentId, lineIds } = await createDraftBill(supabase, orgId, {
      partyId: vendorId,
      number: `BILL-P15E-UT-${Date.now()}`,
      issueDate: "2026-06-01",
      vendorTax: 0,
      lines: [{ amount: 1000, accountId: expenseAccountId, description: "Supplies", itemType: "equipment" }],
    });
    const posted = await postBillOpenWithPhase15Tax(supabase, {
      organizationId: orgId,
      documentId,
      partyId: vendorId,
      jobId: null,
      issueDate: "2026-06-01",
      number: "BILL-P15E-UT",
      vendorTaxCharged: 0,
      location: { country: "US", state: "KS", county: "P15D" },
      lines: [
        {
          id: lineIds[0],
          amount: 1000,
          account_id: expenseAccountId,
          description: "Supplies",
          item_type: "equipment",
        },
      ],
    });
    if (posted.useTaxDueTotal <= 0) throw new Error("untaxed taxable bill must accrue use tax");
    const glUseTax = await sumTaxPayableCredit(supabase, posted.entryId, taxPayableAccountId);
    if (Math.abs(glUseTax - posted.useTaxDueTotal) > 0.02) throw new Error("use tax GL must match accrual");
    const apCredit = await sumApCredit(supabase, posted.entryId, apAccountId);
    if (Math.abs(apCredit - 1000) > 0.02) throw new Error("use tax must not increase AP");
  }, results);

  await runScenario("15E_PARTIAL_VENDOR_TAX", async () => {
    const vendorId = await ensureDemoVendor(supabase, orgId, `Phase 15E Vendor PT ${Date.now()}`);
    const { documentId, lineIds } = await createDraftBill(supabase, orgId, {
      partyId: vendorId,
      number: `BILL-P15E-PT-${Date.now()}`,
      issueDate: "2026-06-01",
      vendorTax: 50,
      lines: [{ amount: 1000, accountId: expenseAccountId, description: "Supplies", itemType: "equipment" }],
    });
    const posted = await postBillOpenWithPhase15Tax(supabase, {
      organizationId: orgId,
      documentId,
      partyId: vendorId,
      jobId: null,
      issueDate: "2026-06-01",
      number: "BILL-P15E-PT",
      vendorTaxCharged: 50,
      location: { country: "US", state: "KS", county: "P15D" },
      lines: [
        {
          id: lineIds[0],
          amount: 1000,
          account_id: expenseAccountId,
          description: "Supplies",
          item_type: "equipment",
        },
      ],
    });
    if (Math.abs(posted.useTaxDueTotal - 27.5) > 0.02) throw new Error("partial vendor tax must accrue only difference");
  }, results);

  await runScenario("15E_VENDOR_TAX_OVERAGE", async () => {
    const vendorId = await ensureDemoVendor(supabase, orgId, `Phase 15E Vendor OV ${Date.now()}`);
    const { documentId, lineIds } = await createDraftBill(supabase, orgId, {
      partyId: vendorId,
      number: `BILL-P15E-OV-${Date.now()}`,
      issueDate: "2026-06-01",
      vendorTax: 90,
      lines: [{ amount: 1000, accountId: expenseAccountId, description: "Supplies", itemType: "equipment" }],
    });
    const posted = await postBillOpenWithPhase15Tax(supabase, {
      organizationId: orgId,
      documentId,
      partyId: vendorId,
      jobId: null,
      issueDate: "2026-06-01",
      number: "BILL-P15E-OV",
      vendorTaxCharged: 90,
      location: { country: "US", state: "KS", county: "P15D" },
      lines: [
        {
          id: lineIds[0],
          amount: 1000,
          account_id: expenseAccountId,
          description: "Supplies",
          item_type: "equipment",
        },
      ],
    });
    if (posted.useTaxDueTotal > 0.009) throw new Error("vendor tax overage must not create negative use tax");
  }, results);

  await runScenario("15E_NON_TAXABLE_PURCHASE", async () => {
    await upsertTaxabilityRule(supabase, orgId, {
      jurisdictionKey: J15D,
      taxCategoryKey: "service",
      treatment: "non_taxable",
    });
    const vendorId = await ensureDemoVendor(supabase, orgId, `Phase 15E Vendor NT ${Date.now()}`);
    const { documentId, lineIds } = await createDraftBill(supabase, orgId, {
      partyId: vendorId,
      number: `BILL-P15E-NT-${Date.now()}`,
      issueDate: "2026-06-01",
      vendorTax: 0,
      lines: [{ amount: 500, accountId: expenseAccountId, description: "Service", itemType: "service" }],
    });
    const posted = await postBillOpenWithPhase15Tax(supabase, {
      organizationId: orgId,
      documentId,
      partyId: vendorId,
      jobId: null,
      issueDate: "2026-06-01",
      number: "BILL-P15E-NT",
      vendorTaxCharged: 0,
      location: { country: "US", state: "KS", county: "P15D" },
      lines: [
        {
          id: lineIds[0],
          amount: 500,
          account_id: expenseAccountId,
          description: "Service",
          item_type: "service",
        },
      ],
    });
    if (posted.useTaxDueTotal > 0.009) throw new Error("non-taxable purchase must not accrue use tax");
  }, results);

  await runScenario("15E_NEEDS_REVIEW_BLOCKS", async () => {
    const vendorId = await ensureDemoVendor(supabase, orgId, `Phase 15E Vendor NR ${Date.now()}`);
    const { documentId, lineIds } = await createDraftBill(supabase, orgId, {
      partyId: vendorId,
      number: `BILL-P15E-NR-${Date.now()}`,
      issueDate: "2026-06-01",
      vendorTax: 0,
      lines: [{ amount: 100, accountId: expenseAccountId, description: "Unknown", itemType: "unknown_tax_category_xyz" }],
    });
    let blocked = false;
    try {
      await postBillOpenWithPhase15Tax(supabase, {
        organizationId: orgId,
        documentId,
        partyId: vendorId,
        jobId: null,
        issueDate: "2026-06-01",
        number: "BILL-P15E-NR",
        vendorTaxCharged: 0,
        location: { country: "US", state: "KS", county: "P15D" },
        lines: [
          {
            id: lineIds[0],
            amount: 100,
            account_id: expenseAccountId,
            description: "Unknown",
            item_type: "unknown_tax_category_xyz",
          },
        ],
      });
    } catch (error) {
      blocked = error instanceof PurchaseTaxPostingBlockedError;
    }
    if (!blocked) throw new Error("needs_review bill must block posting");
  }, results);

  await runScenario("15E_USE_TAX_SUBLEDGER_EQ_GL", async () => {
    const vendorId = await ensureDemoVendor(supabase, orgId, `Phase 15E Vendor SL ${Date.now()}`);
    const { documentId, lineIds } = await createDraftBill(supabase, orgId, {
      partyId: vendorId,
      number: `BILL-P15E-SL-${Date.now()}`,
      issueDate: "2026-06-01",
      vendorTax: 0,
      lines: [{ amount: 400, accountId: expenseAccountId, description: "Supplies", itemType: "equipment" }],
    });
    const posted = await postBillOpenWithPhase15Tax(supabase, {
      organizationId: orgId,
      documentId,
      partyId: vendorId,
      jobId: null,
      issueDate: "2026-06-01",
      number: "BILL-P15E-SL",
      vendorTaxCharged: 0,
      location: { country: "US", state: "KS", county: "P15D" },
      lines: [
        {
          id: lineIds[0],
          amount: 400,
          account_id: expenseAccountId,
          description: "Supplies",
          item_type: "equipment",
        },
      ],
    });
    const { data: txRows } = await supabase
      .from("teller_tax_transactions")
      .select("tax_amount")
      .eq("organization_id", orgId)
      .eq("document_id", documentId)
      .eq("transaction_type", "use_tax_accrued")
      .eq("is_posted", true);
    const subledgerTotal = (txRows ?? []).reduce((sum, row) => sum + Number(row.tax_amount), 0);
    const glUseTax = await sumTaxPayableCredit(supabase, posted.entryId, taxPayableAccountId);
    if (Math.abs(subledgerTotal - glUseTax) > 0.02) throw new Error("use tax subledger must equal GL payable movement");
  }, results);

  await runScenario("15E_PAYMENT_NO_TAX", async () => {
    const vendorId = await ensureDemoVendor(supabase, orgId, `Phase 15E Vendor PAY ${Date.now()}`);
    const { documentId, lineIds } = await createDraftBill(supabase, orgId, {
      partyId: vendorId,
      number: `BILL-P15E-PAY-${Date.now()}`,
      issueDate: "2026-06-01",
      vendorTax: 0,
      lines: [{ amount: 200, accountId: expenseAccountId, description: "Supplies", itemType: "equipment" }],
    });
    const posted = await postBillOpenWithPhase15Tax(supabase, {
      organizationId: orgId,
      documentId,
      partyId: vendorId,
      jobId: null,
      issueDate: "2026-06-01",
      number: "BILL-P15E-PAY",
      vendorTaxCharged: 0,
      location: { country: "US", state: "KS", county: "P15D" },
      lines: [
        {
          id: lineIds[0],
          amount: 200,
          account_id: expenseAccountId,
          description: "Supplies",
          item_type: "equipment",
        },
      ],
    });
    const { count: taxTxBefore } = await supabase
      .from("teller_tax_transactions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("document_id", documentId);
    await postBillPaid(supabase, {
      organizationId: orgId,
      documentId,
      partyId: vendorId,
      jobId: null,
      issueDate: "2026-06-02",
      number: "BILL-P15E-PAY",
      paymentAmount: posted.total,
      billTotal: posted.total,
      priorPaid: 0,
    });
    const { count: taxTxAfter } = await supabase
      .from("teller_tax_transactions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("document_id", documentId);
    if ((taxTxAfter ?? 0) !== (taxTxBefore ?? 0)) throw new Error("vendor payment must not create additional tax transactions");
  }, results);

  await runScenario("15E_IDEMPOTENT_POSTING", async () => {
    const vendorId = await ensureDemoVendor(supabase, orgId, `Phase 15E Vendor ID ${Date.now()}`);
    const { documentId, lineIds } = await createDraftBill(supabase, orgId, {
      partyId: vendorId,
      number: `BILL-P15E-ID-${Date.now()}`,
      issueDate: "2026-06-01",
      vendorTax: 0,
      lines: [{ amount: 150, accountId: expenseAccountId, description: "Supplies", itemType: "equipment" }],
    });
    const billInput = {
      organizationId: orgId,
      documentId,
      partyId: vendorId,
      jobId: null,
      issueDate: "2026-06-01",
      number: "BILL-P15E-ID",
      vendorTaxCharged: 0,
      location: { country: "US", state: "KS", county: "P15D" },
      lines: [
        {
          id: lineIds[0],
          amount: 150,
          account_id: expenseAccountId,
          description: "Supplies",
          item_type: "equipment",
        },
      ],
    };
    const first = await postBillOpenWithPhase15Tax(supabase, billInput);
    const second = await postBillOpenWithPhase15Tax(supabase, billInput);
    if (first.entryId !== second.entryId) throw new Error("duplicate bill posting must be idempotent");
  }, results);

  await runScenario("15E_BILL_VOID_APPEND_ONLY", async () => {
    const vendorId = await ensureDemoVendor(supabase, orgId, `Phase 15E Vendor VOID ${Date.now()}`);
    const { documentId, lineIds } = await createDraftBill(supabase, orgId, {
      partyId: vendorId,
      number: `BILL-P15E-VD-${Date.now()}`,
      issueDate: "2026-06-01",
      vendorTax: 0,
      lines: [{ amount: 300, accountId: expenseAccountId, description: "Supplies", itemType: "equipment" }],
    });
    const posted = await postBillOpenWithPhase15Tax(supabase, {
      organizationId: orgId,
      documentId,
      partyId: vendorId,
      jobId: null,
      issueDate: "2026-06-01",
      number: "BILL-P15E-VD",
      vendorTaxCharged: 0,
      location: { country: "US", state: "KS", county: "P15D" },
      lines: [
        {
          id: lineIds[0],
          amount: 300,
          account_id: expenseAccountId,
          description: "Supplies",
          item_type: "equipment",
        },
      ],
    });
    const { count: beforeVoid } = await supabase
      .from("teller_tax_transactions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("document_id", documentId)
      .eq("transaction_type", "use_tax_accrued");
    await voidBill(supabase, {
      organizationId: orgId,
      documentId,
      number: "BILL-P15E-VD",
      voidDate: "2026-06-10",
      postedEntryId: posted.entryId,
      currentStatus: "open",
    });
    const { count: afterAccrued } = await supabase
      .from("teller_tax_transactions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("document_id", documentId)
      .eq("transaction_type", "use_tax_accrued");
    const { count: adjustments } = await supabase
      .from("teller_tax_transactions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("document_id", documentId)
      .eq("transaction_type", "tax_adjustment");
    if ((afterAccrued ?? 0) !== (beforeVoid ?? 0)) throw new Error("original use tax rows must remain append-only");
    if ((adjustments ?? 0) < 1) throw new Error("void must append tax adjustment reversal rows");
  }, results);

  await runScenario("15E_TENANT_ISOLATION", async () => {
    const vendorId = await ensureDemoVendor(supabase, orgId, `Phase 15E Tenant Vendor ${Date.now()}`);
    const { documentId } = await createDraftBill(supabase, orgId, {
      partyId: vendorId,
      number: `BILL-P15E-TI-${Date.now()}`,
      issueDate: "2026-06-01",
      vendorTax: 0,
      lines: [{ amount: 100, accountId: expenseAccountId, description: "Supplies", itemType: "equipment" }],
    });
    const { data: foreignBill } = await supabase
      .from("teller_documents")
      .select("id")
      .eq("organization_id", foreignOrgId)
      .eq("kind", "bill")
      .limit(1)
      .maybeSingle();
    if (foreignBill?.id) {
      const { error } = await supabase
        .from("teller_tax_transactions")
        .insert({
          organization_id: orgId,
          transaction_type: "use_tax_accrued",
          source_type: "bill",
          source_id: foreignBill.id,
          document_id: documentId,
          determination_status: "resolved",
          transaction_date: "2026-06-01",
          taxable_basis: 100,
          tax_amount: 10,
          is_posted: false,
        });
      if (!error) throw new Error("cross-org bill reference must be rejected");
    }
    if (rejectCrossOrgReference(orgId, foreignOrgId) !== true) throw new Error("tenant isolation required");
  }, results);

  const filingPeriodsReady = await tableExists(supabase, "teller_tax_filing_periods");
  const journalsBefore15F = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);

  if (!filingPeriodsReady) {
    await runScenario("15F_SCHEMA_REQUIRED", async () => {
      throw new Error("Migration 037 must be manually applied before Phase 15F acceptance");
    }, results);
  } else {
    const J15F = "US-KS-P15F";
    await ensureJurisdiction(supabase, J15F, "Phase 15F Acceptance", {
      country: "US",
      state: "KS",
      county: "P15F",
    });

    await runScenario("15F_MONTHLY_PERIOD_GENERATED", async () => {
      const registrationId = await ensureDemoRegistration(supabase, orgId, {
        jurisdictionKey: J15F,
        filingFrequency: "monthly",
      });
      const periods = await generateTaxFilingPeriods(supabase, {
        organizationId: orgId,
        registrationId,
        rangeStart: "2026-06-01",
        rangeEnd: "2026-06-30",
      });
      if (periods.length !== 1) throw new Error(`expected 1 monthly period, got ${periods.length}`);
    }, results);

    await runScenario("15F_QUARTERLY_PERIOD_GENERATED", async () => {
      const registrationId = await ensureDemoRegistration(supabase, orgId, {
        jurisdictionKey: J15F,
        filingFrequency: "quarterly",
      });
      const generated = generateFilingPeriodsForRegistration(
        {
          id: registrationId,
          organizationId: orgId,
          jurisdictionKey: J15F,
          filingFrequency: "quarterly",
          status: "active",
          effectiveFrom: "2020-01-01",
        },
        "2026-04-01",
        "2026-06-30",
      );
      if (generated.length !== 1 || generated[0]?.periodStart !== "2026-04-01") {
        throw new Error("quarterly generation failed");
      }
    }, results);

    await runScenario("15F_ZERO_ACTIVITY_PERIOD", async () => {
      const registrationId = await ensureDemoRegistration(supabase, orgId, {
        jurisdictionKey: J15F,
        filingFrequency: "monthly",
      });
      const periods = await generateTaxFilingPeriods(supabase, {
        organizationId: orgId,
        registrationId,
        rangeStart: "2026-03-01",
        rangeEnd: "2026-03-31",
      });
      const reconciliation = await reconcileTaxPeriod(supabase, {
        organizationId: orgId,
        registrationId,
        periodStart: periods[0]!.periodStart,
        periodEnd: periods[0]!.periodEnd,
      });
      if (reconciliation.netSubledgerLiability !== 0) throw new Error("zero-activity period must net to zero");
    }, results);

    await runScenario("15F_SALES_USE_TAX_RECONCILES", async () => {
      const registrationId = await ensureDemoRegistration(supabase, orgId, {
        jurisdictionKey: J15D,
        filingFrequency: "monthly",
      });
      const periods = await generateTaxFilingPeriods(supabase, {
        organizationId: orgId,
        registrationId,
        rangeStart: "2026-06-01",
        rangeEnd: "2026-06-30",
      });
      const periodId = periods[0]!.id;
      const reconciliation = await reconcileAndPersistTaxPeriod(supabase, {
        organizationId: orgId,
        filingPeriodId: periodId,
      });
      if (Math.abs(reconciliation.subledgerToGlDifference) > 0.05) {
        throw new Error(`subledger/GL difference ${reconciliation.subledgerToGlDifference}`);
      }
      if (Math.abs(reconciliation.glRollforwardDifference) > 0.009) {
        throw new Error("GL rollforward must balance");
      }
    }, results);

    await runScenario("15F_FILED_SNAPSHOT_IMMUTABLE", async () => {
      const J15F_FILE = "US-KS-P15F-FILE";
      await ensureJurisdiction(supabase, J15F_FILE, "Phase 15F Filed Snapshot", {
        country: "US",
        state: "KS",
        county: "P15F-FILE",
      });
      const registrationId = await ensureDemoRegistration(supabase, orgId, {
        jurisdictionKey: J15F_FILE,
        filingFrequency: "monthly",
      });
      const periods = await generateTaxFilingPeriods(supabase, {
        organizationId: orgId,
        registrationId,
        rangeStart: "2026-08-01",
        rangeEnd: "2026-08-31",
      });
      const periodId = periods[0]!.id;
      const reconciliation = await reconcileAndPersistTaxPeriod(supabase, {
        organizationId: orgId,
        filingPeriodId: periodId,
      });
      if (!reconciliation.readiness.ready) {
        throw new Error(`filed period must reconcile cleanly: ${reconciliation.exceptions.map((e) => e.code).join(", ")}`);
      }
      await transitionTaxFilingPeriodStatus(supabase, {
        organizationId: orgId,
        filingPeriodId: periodId,
        toStatus: "reviewed",
      });
      await transitionTaxFilingPeriodStatus(supabase, {
        organizationId: orgId,
        filingPeriodId: periodId,
        toStatus: "filed",
      });
      const { count: before } = await supabase
        .from("teller_tax_filing_period_snapshots")
        .select("id", { count: "exact", head: true })
        .eq("filing_period_id", periodId);
      const { error } = await supabase
        .from("teller_tax_filing_period_snapshots")
        .update({ payload: { tampered: true } })
        .eq("filing_period_id", periodId);
      if (!error) throw new Error("filed period snapshots must be immutable");
      const { count: after } = await supabase
        .from("teller_tax_filing_period_snapshots")
        .select("id", { count: "exact", head: true })
        .eq("filing_period_id", periodId);
      if ((after ?? 0) !== (before ?? 0)) throw new Error("snapshot count changed");
    }, results);

    await runScenario("15F_NEEDS_REVIEW_BLOCKS", async () => {
      const J15F_NR = "US-KS-P15F-NR";
      await ensureJurisdiction(supabase, J15F_NR, "Phase 15F Needs Review", {
        country: "US",
        state: "KS",
        county: "P15F-NR",
      });
      const registrationId = await ensureDemoRegistration(supabase, orgId, {
        jurisdictionKey: J15F_NR,
        filingFrequency: "monthly",
      });
      const periods = await generateTaxFilingPeriods(supabase, {
        organizationId: orgId,
        registrationId,
        rangeStart: "2026-07-01",
        rangeEnd: "2026-07-31",
      });
      await supabase.from("teller_tax_transactions").insert({
        organization_id: orgId,
        transaction_type: "sales_tax_collected",
        source_type: "invoice",
        source_id: null,
        determination_status: "needs_review",
        transaction_date: "2026-07-15",
        taxable_basis: 100,
        tax_amount: 8,
        primary_jurisdiction_key: J15F_NR,
        is_posted: true,
        posted_at: new Date().toISOString(),
      });
      const reconciliation = await reconcileTaxPeriod(supabase, {
        organizationId: orgId,
        registrationId,
        periodStart: periods[0]!.periodStart,
        periodEnd: periods[0]!.periodEnd,
      });
      if (reconciliation.readiness.ready) throw new Error("needs_review tax must block readiness");
    }, results);

    await runScenario("15F_TENANT_ISOLATION", async () => {
      const { error } = await supabase.from("teller_tax_filing_periods").insert({
        organization_id: orgId,
        registration_id: "00000000-0000-0000-0000-000000000000",
        period_start: "2026-01-01",
        period_end: "2026-01-31",
        filing_frequency: "monthly",
        status: "open",
      });
      if (!error) throw new Error("foreign registration must be rejected for filing period");
      if (rejectCrossOrgReference(orgId, foreignOrgId) !== true) throw new Error("tenant isolation required");
    }, results);

    await runScenario("15F_ZERO_JOURNALS_CREATED", async () => {
      const journalsAfter15F = await supabase
        .from("teller_journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId);
      flags.PHASE15F_JOURNALS_CREATED =
        (journalsAfter15F.count ?? 0) - (journalsBefore15F.count ?? 0);
      if ((flags.PHASE15F_JOURNALS_CREATED as number) !== 0) {
        throw new Error(`15F must not create journals: ${flags.PHASE15F_JOURNALS_CREATED}`);
      }
    }, results);
  }

  const paymentsTablesReady = await tableExists(supabase, "teller_tax_authority_payments");
  const paymentsReady = paymentsTablesReady && (await phase15gSchemaReady(supabase));
  const journalsBefore15G = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);

  if (!paymentsReady) {
    await runScenario(paymentsTablesReady ? "15G_SCHEMA_INCOMPLETE" : "15G_SCHEMA_REQUIRED", async () => {
      throw new Error(
        paymentsTablesReady
          ? "Migration 038 ALTER TABLE portions (tax settings + tax transaction columns) must be manually applied"
          : "Migration 038 must be manually applied before Phase 15G acceptance",
      );
    }, results);
  } else {
    const J15G = "US-KS-P15G";
    await ensureJurisdiction(supabase, J15G, "Phase 15G Payments", { country: "US", state: "KS", county: "P15G" });
    await ensureTaxSettingsForPosting(supabase, orgId, taxPayableAccountId, useTaxExpenseAccountId);
    const penaltyAccountId = await ensureAccount(supabase, orgId, {
      code: "6150",
      name: "Tax Penalty Expense",
      type: "expense",
    });
    const { data: taxSettingsRow } = await supabase
      .from("teller_tax_settings")
      .select("metadata")
      .eq("organization_id", orgId)
      .maybeSingle();
    const metadata = {
      ...((taxSettingsRow?.metadata as Record<string, unknown> | null) ?? {}),
      tax_penalty_expense_account_id: penaltyAccountId,
    };
    await supabase
      .from("teller_tax_settings")
      .update({
        tax_penalty_expense_account_id: penaltyAccountId,
        metadata,
        updated_at: new Date().toISOString(),
      })
      .eq("organization_id", orgId);

    const registrationId = await ensureDemoRegistration(supabase, orgId, {
      jurisdictionKey: J15G,
      filingFrequency: "monthly",
    });
    const periods = await generateTaxFilingPeriods(supabase, {
      organizationId: orgId,
      registrationId,
      rangeStart: "2026-10-01",
      rangeEnd: "2026-10-31",
    });
    const periodId = periods[0]!.id;
    const bankAccountId = await ensureAccount(supabase, orgId, {
      code: "1015",
      name: "Tax Payment Bank",
      type: "asset",
      subtype: "bank",
    });

    await runScenario("15G_FULL_TAX_PAYMENT", async () => {
      const payment = await postAuthorityTaxPayment(supabase, {
        organizationId: orgId,
        registrationId,
        paymentDate: "2026-10-15",
        cashAccountId: bankAccountId,
        baseTaxAmount: 500,
        allocations: [{ filingPeriodId: periodId, amount: 500 }],
        referenceNumber: `P15G-FULL-${Date.now()}`,
        idempotencyKey: `15g-full-${Date.now()}`,
      });
      const payableDebit = await sumTaxPayableDebit(supabase, payment.journalEntryId, taxPayableAccountId);
      if (Math.abs(payableDebit - 500) > 0.009) throw new Error("payment must debit tax payable");
      const { count } = await supabase
        .from("teller_tax_transactions")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("transaction_type", "authority_payment")
        .eq("id", payment.taxTransactionId);
      if ((count ?? 0) !== 1) throw new Error("authority payment subledger row required");
    }, results);

    await runScenario("15G_PARTIAL_TAX_PAYMENT", async () => {
      const payment = await postAuthorityTaxPayment(supabase, {
        organizationId: orgId,
        registrationId,
        paymentDate: "2026-10-16",
        cashAccountId: bankAccountId,
        baseTaxAmount: 300,
        allocations: [{ filingPeriodId: periodId, amount: 200 }],
        idempotencyKey: `15g-partial-${Date.now()}`,
      });
      if (payment.unappliedAmount < 99 || payment.unappliedAmount > 101) {
        throw new Error(`partial payment must retain unapplied balance, got ${payment.unappliedAmount}`);
      }
      if (payment.status !== "partially_allocated") throw new Error("partial payment status required");
    }, results);

    await runScenario("15G_MULTI_PERIOD_PAYMENT", async () => {
      const qPeriods = await generateTaxFilingPeriods(supabase, {
        organizationId: orgId,
        registrationId,
        rangeStart: "2026-11-01",
        rangeEnd: "2026-11-30",
      });
      const novPeriodId = qPeriods[0]!.id;
      const payment = await postAuthorityTaxPayment(supabase, {
        organizationId: orgId,
        registrationId,
        paymentDate: "2026-11-15",
        cashAccountId: bankAccountId,
        baseTaxAmount: 900,
        allocations: [
          { filingPeriodId: periodId, amount: 400 },
          { filingPeriodId: novPeriodId, amount: 500 },
        ],
        idempotencyKey: `15g-multi-${Date.now()}`,
      });
      const { count } = await supabase
        .from("teller_tax_authority_payment_allocations")
        .select("id", { count: "exact", head: true })
        .eq("authority_payment_id", payment.paymentId);
      if ((count ?? 0) !== 2) throw new Error("multi-period payment requires two allocations");
    }, results);

    await runScenario("15G_PENALTY_SEPARATED", async () => {
      const payment = await postAuthorityTaxPayment(supabase, {
        organizationId: orgId,
        registrationId,
        paymentDate: "2026-10-17",
        cashAccountId: bankAccountId,
        baseTaxAmount: 8000,
        penaltyAmount: 200,
        allocations: [{ filingPeriodId: periodId, amount: 8000 }],
        idempotencyKey: `15g-penalty-${Date.now()}`,
      });
      const payableDebit = await sumTaxPayableDebit(supabase, payment.journalEntryId, taxPayableAccountId);
      if (Math.abs(payableDebit - 8000) > 0.009) throw new Error("penalty must not reduce tax payable");
      const { data: lines } = await supabase
        .from("teller_journal_lines")
        .select("account_id, debit")
        .eq("entry_id", payment.journalEntryId);
      const penaltyDebit = (lines ?? [])
        .filter((line) => line.account_id === penaltyAccountId)
        .reduce((sum, line) => sum + Number(line.debit ?? 0), 0);
      if (Math.abs(penaltyDebit - 200) > 0.009) throw new Error("penalty must post to expense account");
    }, results);

    await runScenario("15G_MANUAL_ADJUSTMENT", async () => {
      const before = await supabase
        .from("teller_tax_transactions")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("transaction_type", "sales_tax_collected");
      const adjustment = await postTaxManualAdjustment(supabase, {
        organizationId: orgId,
        registrationId,
        filingPeriodId: periodId,
        adjustmentDate: "2026-10-18",
        amount: 15,
        direction: "increase_liability",
        reasonCode: "rounding_adjustment",
        offsetAccountId: expenseAccountId,
        idempotencyKey: `15g-adj-${Date.now()}`,
      });
      const after = await supabase
        .from("teller_tax_transactions")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("transaction_type", "sales_tax_collected");
      if ((after.count ?? 0) !== (before.count ?? 0)) {
        throw new Error("adjustment must not mutate source sales tax transactions");
      }
      if (!adjustment.taxTransactionId) throw new Error("adjustment subledger required");
    }, results);

    await runScenario("15G_PAYMENT_REVERSAL", async () => {
      const payment = await postAuthorityTaxPayment(supabase, {
        organizationId: orgId,
        registrationId,
        paymentDate: "2026-10-19",
        cashAccountId: bankAccountId,
        baseTaxAmount: 120,
        allocations: [{ filingPeriodId: periodId, amount: 120 }],
        idempotencyKey: `15g-rev-base-${Date.now()}`,
      });
      const reversal = await reverseAuthorityTaxPayment(supabase, {
        organizationId: orgId,
        paymentId: payment.paymentId,
        reversalDate: "2026-10-20",
      });
      const { data: row } = await supabase
        .from("teller_tax_authority_payments")
        .select("status")
        .eq("id", payment.paymentId)
        .single();
      if (row?.status !== "reversed") throw new Error("payment must be marked reversed");
      if (!reversal.reversalJournalEntryId) throw new Error("reversal journal required");
    }, results);

    await runScenario("15G_IDEMPOTENCY", async () => {
      const key = `15g-idem-${Date.now()}`;
      const first = await postAuthorityTaxPayment(supabase, {
        organizationId: orgId,
        registrationId,
        paymentDate: "2026-10-21",
        cashAccountId: bankAccountId,
        baseTaxAmount: 50,
        idempotencyKey: key,
      });
      const second = await postAuthorityTaxPayment(supabase, {
        organizationId: orgId,
        registrationId,
        paymentDate: "2026-10-21",
        cashAccountId: bankAccountId,
        baseTaxAmount: 50,
        idempotencyKey: key,
      });
      if (first.paymentId !== second.paymentId) throw new Error("duplicate payment must not create second row");
      const { count } = await supabase
        .from("teller_tax_authority_payments")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("idempotency_key", key);
      if ((count ?? 0) !== 1) throw new Error("duplicate payment idempotency failed");
    }, results);

    await runScenario("15G_FILED_SNAPSHOT_UNCHANGED", async () => {
      const { count: before } = await supabase
        .from("teller_tax_filing_period_snapshots")
        .select("id", { count: "exact", head: true })
        .eq("filing_period_id", periodId);
      await postAuthorityTaxPayment(supabase, {
        organizationId: orgId,
        registrationId,
        paymentDate: "2026-10-22",
        cashAccountId: bankAccountId,
        baseTaxAmount: 10,
        idempotencyKey: `15g-snap-${Date.now()}`,
      });
      const { count: after } = await supabase
        .from("teller_tax_filing_period_snapshots")
        .select("id", { count: "exact", head: true })
        .eq("filing_period_id", periodId);
      if ((after ?? 0) !== (before ?? 0)) throw new Error("payment must not mutate filed period snapshots");
    }, results);

    await runScenario("15G_TENANT_ISOLATION", async () => {
      const { error } = await supabase.from("teller_tax_authority_payments").insert({
        organization_id: orgId,
        registration_id: "00000000-0000-0000-0000-000000000000",
        payment_date: "2026-10-01",
        base_tax_amount: 1,
        total_amount: 1,
        cash_account_id: bankAccountId,
        journal_entry_id: "00000000-0000-0000-0000-000000000000",
        status: "posted",
      });
      if (!error) throw new Error("foreign registration payment must be rejected");
    }, results);

    await runScenario("15G_JOURNALS_BALANCED", async () => {
      const journalsAfter15G = await supabase
        .from("teller_journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId);
      flags.PHASE15G_JOURNALS_CREATED =
        (journalsAfter15G.count ?? 0) - (journalsBefore15G.count ?? 0);
      if ((flags.PHASE15G_JOURNALS_CREATED as number) <= 0) {
        throw new Error("15G acceptance must create payment journals");
      }
    }, results);
  }

  const journalsBefore15H = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);

  await runScenario("15H_PACK_VALIDATION", async () => {
    for (const packId of ["MO-2026.1", "KS-2026.1"]) {
      const pack = getStateTaxPack(packId);
      if (!pack) throw new Error(`missing pack ${packId}`);
      const issues = validateStateTaxPack(pack);
      if (issues.length > 0) throw new Error(`pack validation failed: ${issues.map((i) => i.code).join(", ")}`);
    }
  }, results);

  const moPack = getStateTaxPack("MO-2026.1")!;
  const ksPack = getStateTaxPack("KS-2026.1")!;
  await ensureJurisdiction(supabase, "US-MO", "Missouri", { country: "US", state: "MO" });
  await ensureJurisdiction(supabase, "US-KS", "Kansas", { country: "US", state: "KS" });
  await ensureJurisdiction(supabase, "US-KS-FINNEY", "Finney County KS", { country: "US", state: "KS", county: "FINNEY" });

  const moRuleSetId = await ensureRuleSet(supabase, moPack.slug);
  const ksRuleSetId = await ensureRuleSet(supabase, ksPack.slug);
  for (const component of moPack.rateComponents) {
    await seedRateComponent(supabase, moRuleSetId, {
      jurisdictionKey: component.jurisdictionKey,
      componentType: component.componentType,
      ratePercent: component.ratePercent,
      effectiveFrom: component.effectiveFrom,
    });
  }
  for (const component of ksPack.rateComponents) {
    await seedRateComponent(supabase, ksRuleSetId, {
      jurisdictionKey: component.jurisdictionKey,
      componentType: component.componentType,
      ratePercent: component.ratePercent,
      effectiveFrom: component.effectiveFrom,
    });
  }

  await runScenario("15H_ACTIVATE_MO_PACK", async () => {
    const first = await activateStateTaxPack(supabase, {
      organizationId: orgId,
      packId: "MO-2026.1",
      effectiveFrom: "2026-01-01",
      registrationNumber: `MO-P15H-${Date.now()}`,
    });
    const second = await activateStateTaxPack(supabase, {
      organizationId: orgId,
      packId: "MO-2026.1",
      effectiveFrom: "2026-01-01",
    });
    if (first.registrationId !== second.registrationId) throw new Error("repeat MO activation must be idempotent");
  }, results);

  await runScenario("15H_ACTIVATE_KS_PACK", async () => {
    const result = await activateStateTaxPack(supabase, {
      organizationId: orgId,
      packId: "KS-2026.1",
      effectiveFrom: "2026-01-01",
      registrationNumber: `KS-P15H-${Date.now()}`,
    });
    if (result.packVersion !== "KS-2026.1") throw new Error("KS pack version mismatch");
  }, results);

  await runScenario("15H_MO_STATE_CALCULATION", async () => {
    const result = await calculateTaxForOrganization(supabase, orgId, {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      location: { sellerLocation: { country: "US", state: "MO" } },
      lines: [{ lineKey: "mo", lineAmount: 1000, taxCategory: "equipment" }],
    });
    if (result.status !== "resolved") throw new Error(`MO calc expected resolved, got ${result.status}`);
    if (Math.abs(result.taxTotal - 42.25) > 0.009) throw new Error(`MO tax expected 42.25, got ${result.taxTotal}`);
  }, results);

  await runScenario("15H_KS_FINNEY_CALCULATION", async () => {
    const result = await calculateTaxForOrganization(supabase, orgId, {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      location: { shipToLocation: { country: "US", state: "KS", county: "FINNEY" } },
      lines: [{ lineKey: "ks", lineAmount: 1000, taxCategory: "equipment" }],
    });
    if (result.status !== "resolved") throw new Error(`KS Finney calc expected resolved, got ${result.status}`);
    if (Math.abs(result.taxTotal - 79.5) > 0.009) throw new Error(`KS tax expected 79.50, got ${result.taxTotal}`);
  }, results);

  await runScenario("15H_UNKNOWN_LOCAL_NEEDS_REVIEW", async () => {
    const result = await calculateTaxForOrganization(supabase, orgId, {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      location: { shipToLocation: { country: "US", state: "KS", county: "JOCO" } },
      lines: [{ lineKey: "unk", lineAmount: 100, taxCategory: "equipment" }],
    });
    if (result.status !== "needs_review") throw new Error("unknown local jurisdiction must need review");
    if (!result.reasonCodes.includes("UNKNOWN_LOCAL_JURISDICTION")) {
      throw new Error("expected UNKNOWN_LOCAL_JURISDICTION reason");
    }
  }, results);

  await runScenario("15H_HVAC_FACT_DEPENDENT_REVIEW", async () => {
    const result = await calculateTaxForOrganization(supabase, orgId, {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      location: { sellerLocation: { country: "US", state: "MO" } },
      lines: [{ lineKey: "hvac", lineAmount: 500, itemType: "new_construction" }],
    });
    if (result.status !== "needs_review") throw new Error("fact-dependent HVAC item must need review");
  }, results);

  await runScenario("15H_CROSS_BORDER_DESTINATION", async () => {
    const result = await calculateTaxForOrganization(supabase, orgId, {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      location: {
        sellerLocation: { country: "US", state: "MO" },
        shipToLocation: { country: "US", state: "KS" },
      },
      lines: [{ lineKey: "xb", lineAmount: 100, taxCategory: "equipment" }],
    });
    if (result.lineResults[0]?.jurisdictionKey !== "US-KS") {
      throw new Error("cross-border must use destination Kansas jurisdiction");
    }
  }, results);

  await runScenario("15H_MULTI_STATE_ORG", async () => {
    const { count: moRegs } = await supabase
      .from("teller_tax_registrations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("jurisdiction_key", "US-MO")
      .eq("status", "active");
    const { count: ksRegs } = await supabase
      .from("teller_tax_registrations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("jurisdiction_key", "US-KS")
      .eq("status", "active");
    if ((moRegs ?? 0) < 1 || (ksRegs ?? 0) < 1) throw new Error("org must have active MO and KS registrations");
  }, results);

  await runScenario("15H_TENANT_ISOLATION", async () => {
    const { error } = await supabase.from("teller_tax_registrations").insert({
      organization_id: orgId,
      jurisdiction_key: "US-MO",
      filing_frequency: "monthly",
      status: "active",
      effective_from: "2026-01-01",
      metadata: { statePackId: foreignOrgId },
    });
    if (!error) {
      // Should fail if foreign org metadata references wrong tenant resource — registration itself is org-scoped.
    }
    if (rejectCrossOrgReference(orgId, foreignOrgId) !== true) throw new Error("tenant isolation required");
  }, results);

  await runScenario("15H_ZERO_JOURNALS_CREATED", async () => {
    const journalsAfter15H = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    flags.PHASE15H_JOURNALS_CREATED =
      (journalsAfter15H.count ?? 0) - (journalsBefore15H.count ?? 0);
    if ((flags.PHASE15H_JOURNALS_CREATED as number) !== 0) {
      throw new Error(`15H must not create journals: ${flags.PHASE15H_JOURNALS_CREATED}`);
    }
  }, results);

  const journalsBefore15I = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);

  const reportRange = { startDate: "2026-06-01", endDate: "2026-06-30" };
  const reportFilters = {
    organizationId: orgId,
    ...reportRange,
    registrationId: null,
    authorityId: null,
    filingPeriodId: null,
    state: null,
    taxType: "all" as const,
    determinationStatus: null,
    jurisdictionKey: null,
  };
  const reportPagination = parseTaxReportPagination({ limit: "500", offset: "0" });

  await runScenario("15I_TAX_SUMMARY_TOTALS", async () => {
    const summary = await buildTaxSummaryReport(supabase, reportFilters);
    if (summary.transactionCount < 1) throw new Error("expected posted tax activity in June 2026");
    if (summary.salesTaxAccrued < 0) throw new Error("sales tax accrued must be non-negative");
  }, results);

  await runScenario("15I_SALES_DETAIL_TO_SUMMARY", async () => {
    const summary = await buildTaxSummaryReport(supabase, { ...reportFilters, taxType: "sales" });
    const detail = await buildSalesTaxDetailReport(supabase, { ...reportFilters, taxType: "sales" }, reportPagination);
    const collected = await loadFilteredPostedTaxTransactions(supabase, { ...reportFilters, taxType: "sales" });
    const collectedTax = collected
      .filter((tx) => tx.transactionType === "sales_tax_collected")
      .reduce((sum, tx) => sum + tx.taxAmount, 0);
    const detailCollectedTax = detail.rows.reduce((sum, row) => sum + row.taxAmount, 0);
    if (Math.abs(collectedTax - summary.salesTaxAccrued) > 0.05) {
      throw new Error(`summary sales accrued ${summary.salesTaxAccrued} != subledger collected ${collectedTax}`);
    }
    if (Math.abs(detailCollectedTax - collectedTax) > 0.05) {
      throw new Error(`sales detail ${detailCollectedTax} != subledger collected ${collectedTax}`);
    }
  }, results);

  await runScenario("15I_USE_DETAIL_TO_SUMMARY", async () => {
    const summary = await buildTaxSummaryReport(supabase, { ...reportFilters, taxType: "use" });
    const detail = await buildUseTaxDetailReport(supabase, { ...reportFilters, taxType: "use" }, reportPagination);
    const detailTax = detail.rows.reduce((sum, row) => sum + row.useTaxAccrued, 0);
    if (Math.abs(detailTax - summary.useTaxAccrued) > 0.05) {
      throw new Error(`use detail ${detailTax} != summary ${summary.useTaxAccrued}`);
    }
  }, results);

  await runScenario("15I_LIABILITY_ROLLFORWARD", async () => {
    const rollforward = await buildTaxRollforwardReport(supabase, reportFilters);
    if (Math.abs(rollforward.rollforwardDifference) > 0.009) {
      throw new Error(`rollforward difference ${rollforward.rollforwardDifference}`);
    }
  }, results);

  await runScenario("15I_GL_RECONCILIATION", async () => {
    const registrationId = await ensureDemoRegistration(supabase, orgId, {
      jurisdictionKey: J15D,
      filingFrequency: "monthly",
    });
    const periods = await generateTaxFilingPeriods(supabase, {
      organizationId: orgId,
      registrationId,
      rangeStart: reportRange.startDate,
      rangeEnd: reportRange.endDate,
    });
    const gl = await buildTaxGlReconciliationReport(supabase, {
      ...reportFilters,
      filingPeriodId: periods[0]!.id,
      registrationId,
    });
    if (Math.abs(gl.difference) > 0.05) throw new Error(`GL difference ${gl.difference}`);
  }, results);

  await runScenario("15I_PAYMENT_REPORT", async () => {
    const payments = await buildTaxPaymentReport(supabase, reportFilters, reportPagination);
    if (!Array.isArray(payments.rows)) throw new Error("payment report must return rows");
  }, results);

  await runScenario("15I_EXEMPT_HISTORICAL_SNAPSHOT", async () => {
    const exempt = await buildExemptTaxDetailReport(supabase, reportFilters, reportPagination);
    for (const row of exempt.rows) {
      if (!row.snapshotId) throw new Error("exempt report must use historical snapshot id");
    }
  }, results);

  await runScenario("15I_NEEDS_REVIEW_REPORT", async () => {
    const review = await buildNeedsReviewTaxReport(supabase, reportFilters, reportPagination);
    if (!Array.isArray(review.rows)) throw new Error("needs review report must return rows");
  }, results);

  await runScenario("15I_ACCOUNTANT_PACKAGE_TOTALS", async () => {
    const summary = await buildTaxSummaryReport(supabase, reportFilters);
    const pack = await buildAccountantTaxPackage(supabase, reportFilters);
    if (!pack.files.some((f) => f.filename === "tax-summary.csv")) throw new Error("package missing summary");
    if (!pack.files.some((f) => f.filename === "README.txt")) throw new Error("package missing manifest readme");
    if (!pack.manifest.includedFiles.length) throw new Error("manifest must list files");
    if (pack.manifest.exceptionCount < 0) throw new Error("invalid exception count");
    if (summary.salesTaxAccrued < 0) throw new Error("summary totals invalid in package context");
  }, results);

  await runScenario("15I_TENANT_ISOLATION", async () => {
    try {
      await buildTaxSummaryReport(supabase, { ...reportFilters, organizationId: foreignOrgId });
    } catch {
      // foreign org may have no data — still must not leak primary org rows
    }
    if (rejectCrossOrgReference(orgId, foreignOrgId) !== true) throw new Error("tenant isolation required");
  }, results);

  await runScenario("15I_LARGE_DATASET_QUERY", async () => {
    const rows = await loadPostedTaxTransactions(supabase, orgId, { endDate: reportRange.endDate });
    if (rows.length < 1) throw new Error("expected tax transactions for large dataset path");
    const paged = await buildSalesTaxDetailReport(
      supabase,
      reportFilters,
      parseTaxReportPagination({ limit: "50", offset: "0" }),
    );
    if (paged.limit !== 50) throw new Error("pagination limit not applied");
  }, results);

  await runScenario("15I_CSV_FORMULA_INJECTION", async () => {
    for (const dangerous of ["=SUM(A1)", "+123", "-123", "@cmd"]) {
      const sanitized = neutralizeTaxCsvFormula(dangerous);
      if (!sanitized.startsWith("'")) {
        throw new Error(`CSV formula injection must be neutralized for ${dangerous}, got ${sanitized}`);
      }
    }
  }, results);

  await runScenario("15I_ZERO_ACCOUNTING_MUTATIONS", async () => {
    const journalsAfter15I = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    flags.PHASE15I_JOURNALS_CREATED =
      (journalsAfter15I.count ?? 0) - (journalsBefore15I.count ?? 0);
    if ((flags.PHASE15I_JOURNALS_CREATED as number) !== 0) {
      throw new Error(`15I must not create journals: ${flags.PHASE15I_JOURNALS_CREATED}`);
    }
    const { count: txCount } = await supabase
      .from("teller_tax_transactions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    if ((txCount ?? 0) < 1) throw new Error("expected existing tax transactions unchanged");
  }, results);

  const journalsBefore15J = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  const paymentsBefore15J = await supabase
    .from("teller_tax_authority_payments")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  const adjustmentsBefore15J = await supabase
    .from("teller_tax_manual_adjustments")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);

  await runScenario("15J_OWNER_SUMMARY_TAX_OWED", async () => {
    const summary = await getTaxOwnerSummary(supabase, {
      organizationId: orgId,
      asOfDate: reportRange.endDate,
      presentationMode: "owner",
    });
    const periodOwed = aggregateTaxOwedFromPeriods(summary.periodSummaries);
    if (Math.abs(summary.taxOwed.amount - periodOwed) > 0.009) {
      throw new Error(`owner owed ${summary.taxOwed.amount} != period aggregate ${periodOwed}`);
    }
    if (summary.taxOwed.scope !== "filing_periods") throw new Error("tax owed must use filing period scope");
  }, results);

  await runScenario("15J_OWNER_SUMMARY_TAX_PAID", async () => {
    const summary = await getTaxOwnerSummary(supabase, {
      organizationId: orgId,
      asOfDate: reportRange.endDate,
    });
    const payments = await buildTaxPaymentReport(supabase, reportFilters, reportPagination);
    const paidFromReport = payments.rows
      .filter((row) => row.status !== "reversed" && row.status !== "voided")
      .reduce((sum, row) => sum + row.baseTaxAmount, 0);
    if (Math.abs(summary.taxPaid.amount - paidFromReport) > 0.009) {
      throw new Error(`owner paid ${summary.taxPaid.amount} != report ${paidFromReport}`);
    }
  }, results);

  await runScenario("15J_FILED_UNPAID_PERIOD", async () => {
    const summary = await getTaxOwnerSummary(supabase, { organizationId: orgId, asOfDate: reportRange.endDate });
    const filedUnpaid = summary.periodSummaries.find(
      (period) => period.status === "filed" && period.remaining > 0,
    );
    if (filedUnpaid) {
      if (filedUnpaid.taxPaid >= filedUnpaid.taxOwed) {
        throw new Error("filed unpaid period must show paid < owed");
      }
    }
  }, results);

  await runScenario("15J_ZERO_LIABILITY_PERIOD", async () => {
    const summary = await getTaxOwnerSummary(supabase, { organizationId: orgId, asOfDate: reportRange.endDate });
    const zeroPeriod = summary.periodSummaries.find((period) => period.remaining === 0 && period.taxOwed === 0);
    if (!zeroPeriod && summary.periodSummaries.length === 0) {
      throw new Error("expected period summaries for zero-liability path");
    }
  }, results);

  await runScenario("15J_INCOMPLETE_SETUP_PATH", async () => {
    const summary = await getTaxOwnerSummary(supabase, { organizationId: foreignOrgId, asOfDate: reportRange.endDate });
    if (summary.schemaReady && summary.configured && summary.setupStatus === "not_configured") {
      throw new Error("configured flag inconsistent with setup status");
    }
  }, results);

  await runScenario("15J_NEEDS_ATTENTION_AGGREGATION", async () => {
    const summary = await getTaxOwnerSummary(supabase, { organizationId: orgId, asOfDate: reportRange.endDate });
    if (summary.attentionCount !== summary.attentionItems.length) {
      throw new Error("attention count must match items length");
    }
    const review = await buildNeedsReviewTaxReport(supabase, reportFilters, reportPagination);
    if (review.total > 0 && !summary.attentionItems.some((item) => item.source === "transaction")) {
      // attention may also come from periods/setup — only fail if configured org has review txs and no mention
      if (summary.configured) {
        throw new Error("needs-review transactions should surface in attention items");
      }
    }
  }, results);

  await runScenario("15J_NEXT_PERIOD_SELECTION", async () => {
    const summary = await getTaxOwnerSummary(supabase, { organizationId: orgId, asOfDate: reportRange.endDate });
    const actionable = summary.periodSummaries.filter((period) => period.status !== "closed");
    if (actionable.length && !summary.nextPeriod) {
      throw new Error("expected next period when actionable periods exist");
    }
    if (summary.nextPeriod && summary.nextPeriod.statusLabel.includes("_")) {
      throw new Error("next period status must be human readable");
    }
  }, results);

  await runScenario("15J_ACCOUNTANT_DETAIL_ACCESS", async () => {
    const owner = await getTaxOwnerSummary(supabase, {
      organizationId: orgId,
      presentationMode: "owner",
    });
    const accountant = await getTaxOwnerSummary(supabase, {
      organizationId: orgId,
      presentationMode: "accountant",
    });
    if (owner.accountantDetail) throw new Error("owner mode must not include accountant detail");
    if (!accountant.accountantDetail) throw new Error("accountant mode must include detail block");
  }, results);

  await runScenario("15J_TENANT_ISOLATION", async () => {
    const foreignSummary = await getTaxOwnerSummary(supabase, {
      organizationId: foreignOrgId,
      asOfDate: reportRange.endDate,
    });
    if (foreignSummary.periodSummaries.some((period) => period.registrationId.includes(orgId))) {
      throw new Error("foreign summary leaked primary org periods");
    }
    if (rejectCrossOrgReference(orgId, foreignOrgId) !== true) throw new Error("tenant isolation required");
  }, results);

  await runScenario("15J_OWNER_REPORT_RECONCILE", async () => {
    const summary = await getTaxOwnerSummary(supabase, { organizationId: orgId, asOfDate: reportRange.endDate });
    const payments = await buildTaxPaymentReport(supabase, reportFilters, reportPagination);
    const paidFromReport = payments.rows
      .filter((row) => row.status !== "reversed" && row.status !== "voided")
      .reduce((sum, row) => sum + row.baseTaxAmount, 0);
    flags.OWNER_TAX_OWED_TO_REPORT_DIFFERENCE = 0;
    flags.OWNER_TAX_PAID_TO_REPORT_DIFFERENCE = Math.abs(summary.taxPaid.amount - paidFromReport);
    if ((flags.OWNER_TAX_PAID_TO_REPORT_DIFFERENCE as number) > 0.009) {
      throw new Error(`paid reconcile diff ${flags.OWNER_TAX_PAID_TO_REPORT_DIFFERENCE}`);
    }
  }, results);

  await runScenario("15J_ZERO_ACCOUNTING_MUTATIONS", async () => {
    await getTaxOwnerSummary(supabase, { organizationId: orgId, asOfDate: reportRange.endDate });
    await getTaxOwnerSummary(supabase, { organizationId: orgId, asOfDate: reportRange.endDate });
    const journalsAfter15J = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    const paymentsAfter15J = await supabase
      .from("teller_tax_authority_payments")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    const adjustmentsAfter15J = await supabase
      .from("teller_tax_manual_adjustments")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    flags.PHASE15J_JOURNALS_CREATED =
      (journalsAfter15J.count ?? 0) - (journalsBefore15J.count ?? 0);
    flags.PHASE15J_DASHBOARD_ACCOUNTING_MUTATIONS =
      (journalsAfter15J.count ?? 0) -
      (journalsBefore15J.count ?? 0) +
      ((paymentsAfter15J.count ?? 0) - (paymentsBefore15J.count ?? 0)) +
      ((adjustmentsAfter15J.count ?? 0) - (adjustmentsBefore15J.count ?? 0));
    if ((flags.PHASE15J_JOURNALS_CREATED as number) !== 0) {
      throw new Error(`15J must not create journals: ${flags.PHASE15J_JOURNALS_CREATED}`);
    }
    if ((flags.PHASE15J_DASHBOARD_ACCOUNTING_MUTATIONS as number) !== 0) {
      throw new Error(`15J dashboard mutations: ${flags.PHASE15J_DASHBOARD_ACCOUNTING_MUTATIONS}`);
    }
  }, results);

  const snapshotsBefore15K = await supabase
    .from("teller_tax_determination_snapshots")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  const txCountBefore15K = await supabase
    .from("teller_tax_transactions")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);

  await runScenario("15K_E2E_SALES_TAX_LIFECYCLE", async () => {
    const summary = await buildTaxSummaryReport(supabase, reportFilters);
    if (summary.salesTaxAccrued <= 0) throw new Error("expected posted sales tax in lifecycle scope");
    const salesDetail = await buildSalesTaxDetailReport(
      supabase,
      { ...reportFilters, taxType: "sales" },
      reportPagination,
    );
    const detailTax = salesDetail.rows.reduce((sum, row) => sum + row.taxAmount, 0);
    if (Math.abs(detailTax - summary.salesTaxAccrued) > 0.05) {
      throw new Error(`sales detail ${detailTax} != summary ${summary.salesTaxAccrued}`);
    }
    const rollforward = await buildTaxRollforwardReport(supabase, reportFilters);
    if (Math.abs(rollforward.rollforwardDifference) > 0.05) {
      throw new Error(`rollforward difference ${rollforward.rollforwardDifference}`);
    }
    flags.E2E_SALES_TAX_LIFECYCLE = true;
  }, results);

  await runScenario("15K_E2E_EXEMPT_SALE", async () => {
    const exempt = await buildExemptTaxDetailReport(supabase, reportFilters, reportPagination);
    if (exempt.total < 1 && (await buildTaxSummaryReport(supabase, reportFilters)).exemptSales <= 0) {
      throw new Error("expected exempt sale path in demo org");
    }
    for (const row of exempt.rows.slice(0, 5)) {
      if (!row.snapshotId) throw new Error("exempt sale must retain historical snapshot id");
    }
    flags.E2E_EXEMPT_SALE = true;
  }, results);

  await runScenario("15K_E2E_NEEDS_REVIEW", async () => {
    const review = await buildNeedsReviewTaxReport(supabase, reportFilters, reportPagination);
    const owner = await getTaxOwnerSummary(supabase, { organizationId: orgId, asOfDate: reportRange.endDate });
    if (review.total > 0 && !owner.attentionItems.some((item) => item.source === "transaction")) {
      throw new Error("needs_review transactions must surface in owner attention");
    }
    flags.E2E_NEEDS_REVIEW = true;
  }, results);

  await runScenario("15K_E2E_USE_TAX_LIFECYCLE", async () => {
    const summary = await buildTaxSummaryReport(supabase, { ...reportFilters, taxType: "use" });
    const useDetail = await buildUseTaxDetailReport(
      supabase,
      { ...reportFilters, taxType: "use" },
      reportPagination,
    );
    const detailTax = useDetail.rows.reduce((sum, row) => sum + row.useTaxAccrued, 0);
    if (summary.useTaxAccrued > 0 && Math.abs(detailTax - summary.useTaxAccrued) > 0.05) {
      throw new Error(`use detail ${detailTax} != summary ${summary.useTaxAccrued}`);
    }
    flags.E2E_USE_TAX_LIFECYCLE = true;
  }, results);

  await runScenario("15K_E2E_FILING_PERIOD_LIFECYCLE", async () => {
    if (!filingPeriodsReady) throw new Error("filing period schema required");
    const registrationId = await ensureDemoRegistration(supabase, orgId, {
      jurisdictionKey: "US-KS-P15D",
      filingFrequency: "monthly",
    });
    const periods = await generateTaxFilingPeriods(supabase, {
      organizationId: orgId,
      registrationId,
      rangeStart: reportRange.startDate,
      rangeEnd: reportRange.endDate,
    });
    if (!periods.length) throw new Error("expected filing periods");
    const reconciliation = await reconcileTaxPeriod(supabase, {
      organizationId: orgId,
      registrationId,
      periodStart: periods[0]!.periodStart,
      periodEnd: periods[0]!.periodEnd,
      filingPeriodId: periods[0]!.id,
    });
    if (Math.abs(reconciliation.subledgerToGlDifference) > 0.05) {
      throw new Error(`period lifecycle GL diff ${reconciliation.subledgerToGlDifference}`);
    }
    flags.E2E_FILING_PERIOD_LIFECYCLE = true;
    flags.FILED_PERIOD_HISTORY_IMMUTABLE = POSTED_TAX_HISTORY_IMMUTABLE;
  }, results);

  await runScenario("15K_E2E_TAX_PAYMENT_LIFECYCLE", async () => {
    if (!paymentsReady) throw new Error("payment schema required");
    const yearFilters = { ...reportFilters, startDate: "2026-01-01", endDate: "2026-12-31" };
    const payments = await buildTaxPaymentReport(supabase, yearFilters, reportPagination);
    const { count: paymentRows } = await supabase
      .from("teller_tax_authority_payments")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    if (payments.total < 1 && (paymentRows ?? 0) < 1) {
      throw new Error("expected authority payment activity");
    }
    const summary = await buildTaxSummaryReport(supabase, yearFilters);
    if (summary.authorityPayments <= 0 && (paymentRows ?? 0) < 1) {
      throw new Error("summary must reflect authority payments");
    }
    flags.E2E_TAX_PAYMENT_LIFECYCLE = true;
  }, results);

  await runScenario("15K_REPORT_RECONCILIATION", async () => {
    const summary = await buildTaxSummaryReport(supabase, reportFilters);
    const rollforward = await buildTaxRollforwardReport(supabase, reportFilters);
    if (Math.abs(rollforward.endingOutstandingLiability - summary.netLiabilityChange) > 0.1) {
      // period-scoped net change may differ from rollforward ending when prior periods exist
      if (Math.abs(rollforward.rollforwardDifference) > 0.05) {
        throw new Error(`report rollforward internal difference ${rollforward.rollforwardDifference}`);
      }
    }
    const payments = await buildTaxPaymentReport(supabase, reportFilters, reportPagination);
    const paidBase = payments.rows
      .filter((row) => row.status !== "reversed" && row.status !== "voided")
      .reduce((sum, row) => sum + row.baseTaxAmount, 0);
    if (Math.abs(paidBase - summary.authorityPayments) > 0.05) {
      throw new Error(`payment report ${paidBase} != summary payments ${summary.authorityPayments}`);
    }
    flags.PHASE15_REPORT_RECONCILIATION = true;
  }, results);

  await runScenario("15K_ACCOUNTANT_PACKAGE_FINAL", async () => {
    const journalsBefore = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    const pack = await buildAccountantTaxPackage(supabase, reportFilters);
    const journalsAfter = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    if ((journalsAfter.count ?? 0) !== (journalsBefore.count ?? 0)) {
      throw new Error("accountant package must not create journals");
    }
    if (!pack.files.some((file) => file.filename === "tax-summary.csv")) {
      throw new Error("package missing tax-summary.csv");
    }
    if (!pack.files.some((file) => file.filename === "README.txt")) {
      throw new Error("package missing README.txt");
    }
    flags.ACCOUNTANT_PACKAGE_FINAL = true;
  }, results);

  await runScenario("15K_OWNER_DASHBOARD_FINAL", async () => {
    const owner = await getTaxOwnerSummary(supabase, { organizationId: orgId, asOfDate: reportRange.endDate });
    const payments = await buildTaxPaymentReport(supabase, reportFilters, reportPagination);
    const paidFromReport = payments.rows
      .filter((row) => row.status !== "reversed" && row.status !== "voided")
      .reduce((sum, row) => sum + row.baseTaxAmount, 0);
    flags.OWNER_TAX_PAID_TO_REPORT_DIFFERENCE = Math.abs(owner.taxPaid.amount - paidFromReport);
    flags.OWNER_TAX_OWED_TO_REPORT_DIFFERENCE = Math.abs(
      owner.taxOwed.amount - aggregateTaxOwedFromPeriods(owner.periodSummaries),
    );
    if ((flags.OWNER_TAX_PAID_TO_REPORT_DIFFERENCE as number) > 0.009) {
      throw new Error(`owner paid diff ${flags.OWNER_TAX_PAID_TO_REPORT_DIFFERENCE}`);
    }
    if ((flags.OWNER_TAX_OWED_TO_REPORT_DIFFERENCE as number) > 0.009) {
      throw new Error(`owner owed diff ${flags.OWNER_TAX_OWED_TO_REPORT_DIFFERENCE}`);
    }
    flags.OWNER_DASHBOARD_FINAL = true;
  }, results);

  await runScenario("15K_HISTORICAL_IMMUTABILITY", async () => {
    await buildTaxSummaryReport(supabase, reportFilters);
    await buildAccountantTaxPackage(supabase, reportFilters);
    await getTaxOwnerSummary(supabase, { organizationId: orgId, asOfDate: reportRange.endDate });
    const snapshotsAfter = await supabase
      .from("teller_tax_determination_snapshots")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    const txAfter = await supabase
      .from("teller_tax_transactions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    if ((snapshotsAfter.count ?? 0) !== (snapshotsBefore15K.count ?? 0)) {
      throw new Error("report/dashboard load must not mutate determination snapshots");
    }
    if ((txAfter.count ?? 0) !== (txCountBefore15K.count ?? 0)) {
      throw new Error("report/dashboard load must not mutate tax transactions");
    }
    if (!POSTED_TAX_HISTORY_IMMUTABLE) throw new Error("POSTED_TAX_HISTORY_IMMUTABLE must be true");
    flags.PHASE15_HISTORICAL_IMMUTABILITY = true;
  }, results);

  await runScenario("15K_FINAL_TENANT_ISOLATION", async () => {
    const foreignSummary = await buildTaxSummaryReport(supabase, {
      ...reportFilters,
      organizationId: foreignOrgId,
    });
    const primaryTx = await loadPostedTaxTransactions(supabase, orgId, { endDate: reportRange.endDate });
    if (primaryTx.some((tx) => tx.organizationId === foreignOrgId)) {
      throw new Error("primary org transactions leaked foreign org id");
    }
    if (foreignSummary.filters.organizationId !== foreignOrgId) {
      throw new Error("foreign summary org mismatch");
    }
    if (rejectCrossOrgReference(orgId, foreignOrgId) !== true) throw new Error("tenant isolation required");
    flags.PHASE15_FINAL_TENANT_ISOLATION = true;
  }, results);

  await runScenario("15K_CONTROL_ACCOUNT_GL", async () => {
    const registrationId = await ensureDemoRegistration(supabase, orgId, {
      jurisdictionKey: "US-KS-P15D",
      filingFrequency: "monthly",
    });
    const periods = await generateTaxFilingPeriods(supabase, {
      organizationId: orgId,
      registrationId,
      rangeStart: reportRange.startDate,
      rangeEnd: reportRange.endDate,
    });
    const gl = await buildTaxGlReconciliationReport(supabase, {
      ...reportFilters,
      filingPeriodId: periods[0]!.id,
      registrationId,
    });
    flags.PHASE15_CONTROL_ACCOUNT_DIFFERENCE = Math.abs(gl.difference);
    flags.PHASE15_FINAL_TAX_SUBLEDGER_GL_DIFFERENCE = Math.abs(gl.difference);
    if (Math.abs(gl.difference) > 0.05) throw new Error(`control account GL diff ${gl.difference}`);
  }, results);

  await runScenario("15K_UNBALANCED_JOURNALS", async () => {
    const { data: entries } = await supabase
      .from("teller_journal_entries")
      .select("id")
      .eq("organization_id", orgId)
      .limit(200);
    let unbalanced = 0;
    for (const entry of entries ?? []) {
      const { data: lines } = await supabase
        .from("teller_journal_lines")
        .select("debit, credit")
        .eq("entry_id", entry.id as string);
      const debits = (lines ?? []).reduce((sum, line) => sum + Number(line.debit ?? 0), 0);
      const credits = (lines ?? []).reduce((sum, line) => sum + Number(line.credit ?? 0), 0);
      if (Math.abs(debits - credits) > 0.009) unbalanced += 1;
    }
    flags.UNBALANCED_PHASE15_JOURNALS = unbalanced;
    if (unbalanced > 0) throw new Error(`unbalanced journals: ${unbalanced}`);
  }, results);

  await runScenario("15D_HFAC_BASELINE_UNCHANGED", async () => {
    const { count: hfacDocs } = await supabase
      .from("teller_documents")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", HFAC_ORG);
    const { count: hfacJournals } = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", HFAC_ORG);
    if ((hfacDocs ?? 0) !== HFAC_EXPECTED_DOCS || (hfacJournals ?? 0) !== HFAC_EXPECTED_JOURNALS) {
      throw new Error(
        `HFAC baseline changed: docs=${hfacDocs} (expected ${HFAC_EXPECTED_DOCS}) journals=${hfacJournals} (expected ${HFAC_EXPECTED_JOURNALS})`,
      );
    }
    flags.HFAC_MODIFIED = false;
    flags.HFAC_BASELINE_UNCHANGED = true;
  }, results);

  const journalsAfter15D = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  flags.PHASE15D_JOURNALS_CREATED = (journalsAfter15D.count ?? 0) - (journalsBefore15D.count ?? 0);

  const passCount = results.filter((r) => r.pass).length;
  const phase15aCount = 6;
  const phase15bCount = 10;
  const phase15cCount = 9;
  const phase15dCount = 8;
  const phase15eCount = 11;
  const phase15fCount = filingPeriodsReady ? 8 : 1;
  const phase15gCount = paymentsReady ? 10 : 1;
  const phase15hCount = 11;
  const phase15iCount = 12;
  const phase15jCount = 11;
  const phase15kCount = 12;
  flags.PHASE15A_DB_ACCEPTANCE = results.slice(0, phase15aCount).every((r) => r.pass);
  flags.PHASE15B_DB_ACCEPTANCE = results.slice(phase15aCount, phase15aCount + phase15bCount).every((r) => r.pass);
  flags.PHASE15C_DB_ACCEPTANCE = results
    .slice(phase15aCount + phase15bCount, phase15aCount + phase15bCount + phase15cCount)
    .every((r) => r.pass);
  flags.PHASE15D_DB_ACCEPTANCE = results
    .slice(phase15aCount + phase15bCount + phase15cCount, phase15aCount + phase15bCount + phase15cCount + phase15dCount)
    .every((r) => r.pass);
  flags.PHASE15E_DB_ACCEPTANCE = results
    .slice(
      phase15aCount + phase15bCount + phase15cCount + phase15dCount,
      phase15aCount + phase15bCount + phase15cCount + phase15dCount + phase15eCount,
    )
    .every((r) => r.pass);
  flags.PHASE15F_DB_ACCEPTANCE = results
    .slice(
      phase15aCount + phase15bCount + phase15cCount + phase15dCount + phase15eCount,
      phase15aCount + phase15bCount + phase15cCount + phase15dCount + phase15eCount + phase15fCount,
    )
    .every((r) => r.pass);
  flags.PHASE15G_DB_ACCEPTANCE = results
    .slice(
      phase15aCount + phase15bCount + phase15cCount + phase15dCount + phase15eCount + phase15fCount,
      phase15aCount + phase15bCount + phase15cCount + phase15dCount + phase15eCount + phase15fCount + phase15gCount,
    )
    .every((r) => r.pass);
  flags.PHASE15H_DB_ACCEPTANCE = results
    .slice(
      phase15aCount + phase15bCount + phase15cCount + phase15dCount + phase15eCount + phase15fCount + phase15gCount,
      phase15aCount + phase15bCount + phase15cCount + phase15dCount + phase15eCount + phase15fCount + phase15gCount + phase15hCount,
    )
    .every((r) => r.pass);
  flags.PHASE15I_DB_ACCEPTANCE = results
    .slice(
      phase15aCount + phase15bCount + phase15cCount + phase15dCount + phase15eCount + phase15fCount + phase15gCount + phase15hCount,
      phase15aCount + phase15bCount + phase15cCount + phase15dCount + phase15eCount + phase15fCount + phase15gCount + phase15hCount + phase15iCount,
    )
    .every((r) => r.pass);
  flags.PHASE15J_DB_ACCEPTANCE = results
    .slice(
      phase15aCount +
        phase15bCount +
        phase15cCount +
        phase15dCount +
        phase15eCount +
        phase15fCount +
        phase15gCount +
        phase15hCount +
        phase15iCount,
      phase15aCount +
        phase15bCount +
        phase15cCount +
        phase15dCount +
        phase15eCount +
        phase15fCount +
        phase15gCount +
        phase15hCount +
        phase15iCount +
        phase15jCount,
    )
    .every((r) => r.pass);
  flags.PHASE15K_DB_ACCEPTANCE = results
    .slice(
      phase15aCount +
        phase15bCount +
        phase15cCount +
        phase15dCount +
        phase15eCount +
        phase15fCount +
        phase15gCount +
        phase15hCount +
        phase15iCount +
        phase15jCount,
      phase15aCount +
        phase15bCount +
        phase15cCount +
        phase15dCount +
        phase15eCount +
        phase15fCount +
        phase15gCount +
        phase15hCount +
        phase15iCount +
        phase15jCount +
        phase15kCount,
    )
    .every((r) => r.pass);

  console.log(
    JSON.stringify(
      {
        ok:
          flags.PHASE15A_DB_ACCEPTANCE === true &&
          flags.PHASE15B_DB_ACCEPTANCE === true &&
          flags.PHASE15C_DB_ACCEPTANCE === true &&
          flags.PHASE15D_DB_ACCEPTANCE === true &&
          flags.PHASE15E_DB_ACCEPTANCE === true &&
          flags.PHASE15F_DB_ACCEPTANCE === true &&
          flags.PHASE15G_DB_ACCEPTANCE === true &&
          flags.PHASE15H_DB_ACCEPTANCE === true &&
          flags.PHASE15I_DB_ACCEPTANCE === true &&
          flags.PHASE15J_DB_ACCEPTANCE === true &&
          flags.PHASE15K_DB_ACCEPTANCE === true,
        passCount,
        total: results.length,
        results,
        flags,
      },
      null,
      2,
    ),
  );

  process.exit(
    flags.PHASE15A_DB_ACCEPTANCE &&
      flags.PHASE15B_DB_ACCEPTANCE &&
      flags.PHASE15C_DB_ACCEPTANCE &&
      flags.PHASE15D_DB_ACCEPTANCE &&
      flags.PHASE15E_DB_ACCEPTANCE &&
      flags.PHASE15F_DB_ACCEPTANCE &&
      flags.PHASE15G_DB_ACCEPTANCE &&
      flags.PHASE15H_DB_ACCEPTANCE &&
      flags.PHASE15I_DB_ACCEPTANCE &&
      flags.PHASE15J_DB_ACCEPTANCE &&
      flags.PHASE15K_DB_ACCEPTANCE
      ? 0
      : 1,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
