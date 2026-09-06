/**
 * Controlled production test mode for early-stage Teller (ypixbxicdecwfafculha).
 * Distinct from destructive integration tests — requires explicit opt-in and test-org guards.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseSupabaseProjectRef, TELLER_PRODUCTION_SUPABASE_PROJECT_REFS } from "./safety";

export const TELLER_CONTROLLED_PROD_TEST_FLAG = "TELLER_CONTROLLED_PROD_TEST";

export const TELLER_HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";

export const CONTROLLED_TEST_ORG_NAME = "Teller Phase 4 Test";
export const CONTROLLED_FOREIGN_TEST_ORG_NAME = "Teller Phase 4 Foreign Test";
export const CONTROLLED_PHASE5_DEMO_ORG_NAME = "Teller Phase 5 Demo";
export const CONTROLLED_PHASE6_DEMO_ORG_NAME = "Teller Phase 6 Demo";
export const CONTROLLED_PHASE6_FOREIGN_ORG_NAME = "Teller Phase 6 Foreign Test";
export const CONTROLLED_PHASE7_DEMO_ORG_NAME = "Teller Phase 7 Demo";
export const CONTROLLED_PHASE7_FOREIGN_ORG_NAME = "Teller Phase 7 Foreign Test";

export const CONTROLLED_TEST_ORG_METADATA_MARKER = "teller_phase4_controlled_test";

export type ControlledProdTestConfig = {
  projectRef: string;
  testOrganizationId: string;
  foreignOrganizationId?: string | null;
};

export function controlledProdTestEnabled(): boolean {
  return process.env[TELLER_CONTROLLED_PROD_TEST_FLAG] === "1";
}

export function evaluateControlledProdTestSafety(input?: {
  supabaseUrl?: string | null;
  controlledProdTest?: string | null;
  testOrganizationId?: string | null;
}): { allowed: boolean; reason: string; projectRef: string } {
  const supabaseUrl = input?.supabaseUrl ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const projectRef = parseSupabaseProjectRef(supabaseUrl) ?? "";

  if (process.env.RUN_INTEGRATION_TESTS === "1" || process.env.TELLER_ALLOW_INTEGRATION_DB === "1") {
    return {
      allowed: false,
      reason:
        "Controlled prod test cannot run with RUN_INTEGRATION_TESTS or TELLER_ALLOW_INTEGRATION_DB enabled",
      projectRef,
    };
  }

  const flag = input?.controlledProdTest ?? process.env[TELLER_CONTROLLED_PROD_TEST_FLAG];
  if (flag !== "1") {
    return {
      allowed: false,
      reason: `${TELLER_CONTROLLED_PROD_TEST_FLAG} must equal 1`,
      projectRef,
    };
  }

  if (!projectRef || !(TELLER_PRODUCTION_SUPABASE_PROJECT_REFS as readonly string[]).includes(projectRef)) {
    return {
      allowed: false,
      reason: "Controlled prod test requires the known Teller production project ref",
      projectRef,
    };
  }

  const testOrgId = input?.testOrganizationId ?? process.env.TELLER_CONTROLLED_TEST_ORG_ID;
  if (!testOrgId?.trim()) {
    return {
      allowed: false,
      reason: "TELLER_CONTROLLED_TEST_ORG_ID must be set after test org is created",
      projectRef,
    };
  }

  if (testOrgId.trim() === TELLER_HFAC_ORG_ID) {
    return {
      allowed: false,
      reason: "TELLER_CONTROLLED_TEST_ORG_ID must not be the Hassle Free AC organization",
      projectRef,
    };
  }

  return { allowed: true, reason: "ok", projectRef };
}

export function assertControlledProdTestEnabled(config?: Partial<ControlledProdTestConfig>): void {
  const result = evaluateControlledProdTestSafety({
    testOrganizationId: config?.testOrganizationId ?? process.env.TELLER_CONTROLLED_TEST_ORG_ID,
  });
  if (!result.allowed) {
    throw new Error(`Controlled production test blocked: ${result.reason}`);
  }
}

export function assertNotHfacOrganization(organizationId: string): void {
  if (organizationId === TELLER_HFAC_ORG_ID) {
    throw new Error("Refusing to mutate Hassle Free AC organization data");
  }
}

export function assertControlledTestOrganizationId(
  organizationId: string,
  expectedOrganizationId: string,
): void {
  assertNotHfacOrganization(organizationId);
  if (organizationId !== expectedOrganizationId) {
    throw new Error(
      `Organization ${organizationId} is not the configured controlled test org ${expectedOrganizationId}`,
    );
  }
}

export function isControlledTestOrgName(name: string | null | undefined): boolean {
  const normalized = name?.trim() ?? "";
  return (
    normalized === CONTROLLED_TEST_ORG_NAME ||
    normalized === CONTROLLED_FOREIGN_TEST_ORG_NAME ||
    normalized === CONTROLLED_PHASE5_DEMO_ORG_NAME ||
    normalized === CONTROLLED_PHASE6_DEMO_ORG_NAME ||
    normalized === CONTROLLED_PHASE6_FOREIGN_ORG_NAME ||
    normalized === CONTROLLED_PHASE7_DEMO_ORG_NAME ||
    normalized === CONTROLLED_PHASE7_FOREIGN_ORG_NAME
  );
}

export async function loadControlledTestOrganization(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ id: string; name: string; legal_name: string }> {
  assertNotHfacOrganization(organizationId);

  const { data, error } = await supabase
    .from("teller_organizations")
    .select("id, name, legal_name")
    .eq("id", organizationId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error(`Controlled test organization ${organizationId} not found`);

  if (!isControlledTestOrgName(data.name)) {
    throw new Error(
      `Organization name "${data.name}" is not an approved controlled test marker (${CONTROLLED_TEST_ORG_NAME} / ${CONTROLLED_FOREIGN_TEST_ORG_NAME})`,
    );
  }

  if (data.id === TELLER_HFAC_ORG_ID) {
    throw new Error("Configured organization is Hassle Free AC — refusing");
  }

  return data;
}

export async function assertResourceOrganization(
  supabase: SupabaseClient,
  table:
    | "teller_documents"
    | "teller_payments"
    | "teller_payment_allocations"
    | "teller_document_allocations"
    | "teller_journal_entries"
    | "teller_write_offs"
    | "teller_parties"
    | "teller_accounts",
  resourceId: string,
  expectedOrganizationId: string,
): Promise<void> {
  assertControlledTestOrganizationId(expectedOrganizationId, expectedOrganizationId);

  const { data, error } = await supabase
    .from(table)
    .select("organization_id")
    .eq("id", resourceId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error(`${table} row ${resourceId} not found`);
  if (data.organization_id !== expectedOrganizationId) {
    throw new Error(
      `${table} row ${resourceId} belongs to org ${data.organization_id}, expected ${expectedOrganizationId}`,
    );
  }
}

export async function assertJournalEntryOrganization(
  supabase: SupabaseClient,
  entryId: string,
  expectedOrganizationId: string,
): Promise<void> {
  await assertResourceOrganization(
    supabase,
    "teller_journal_entries",
    entryId,
    expectedOrganizationId,
  );
}
