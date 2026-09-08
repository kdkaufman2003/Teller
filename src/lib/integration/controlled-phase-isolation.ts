/**
 * Controlled-production demo org isolation — each phase runner may only mutate its own org.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  CONTROLLED_PHASE5_DEMO_ORG_NAME,
  CONTROLLED_PHASE6_DEMO_ORG_NAME,
  CONTROLLED_PHASE7_DEMO_ORG_NAME,
  CONTROLLED_PHASE8_DEMO_ORG_NAME,
  CONTROLLED_PHASE9_DEMO_ORG_NAME,
  CONTROLLED_PHASE10_DEMO_ORG_NAME,
  CONTROLLED_PHASE11_DEMO_ORG_NAME,
  CONTROLLED_PHASE12_DEMO_ORG_NAME,
  CONTROLLED_PHASE12_FOREIGN_ORG_NAME,
  CONTROLLED_PHASE13_DEMO_ORG_NAME,
  TELLER_HFAC_ORG_ID,
} from "./controlled-prod-test";

export type ControlledPhase = 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

export type OrgEconomicFingerprint = {
  documents: number;
  journals: number;
  jobs: number;
};

const PHASE_CONFIG: Record<
  ControlledPhase,
  { envKey: string; orgName: string }
> = {
  5: { envKey: "TELLER_PHASE5_DEMO_ORG_ID", orgName: CONTROLLED_PHASE5_DEMO_ORG_NAME },
  6: { envKey: "TELLER_PHASE6_DEMO_ORG_ID", orgName: CONTROLLED_PHASE6_DEMO_ORG_NAME },
  7: { envKey: "TELLER_PHASE7_DEMO_ORG_ID", orgName: CONTROLLED_PHASE7_DEMO_ORG_NAME },
  8: { envKey: "TELLER_PHASE8_DEMO_ORG_ID", orgName: CONTROLLED_PHASE8_DEMO_ORG_NAME },
  9: { envKey: "TELLER_PHASE9_DEMO_ORG_ID", orgName: CONTROLLED_PHASE9_DEMO_ORG_NAME },
  10: { envKey: "TELLER_PHASE10_DEMO_ORG_ID", orgName: CONTROLLED_PHASE10_DEMO_ORG_NAME },
  11: { envKey: "TELLER_PHASE11_DEMO_ORG_ID", orgName: CONTROLLED_PHASE11_DEMO_ORG_NAME },
  12: { envKey: "TELLER_PHASE12_DEMO_ORG_ID", orgName: CONTROLLED_PHASE12_DEMO_ORG_NAME },
  13: { envKey: "TELLER_PHASE13_DEMO_ORG_ID", orgName: CONTROLLED_PHASE13_DEMO_ORG_NAME },
};

const ALL_PHASES: ControlledPhase[] = [5, 6, 7, 8, 9, 10, 11, 12, 13];

export function controlledDemoOrgIdFromEnv(phase: ControlledPhase): string | null {
  return process.env[PHASE_CONFIG[phase].envKey]?.trim() ?? null;
}

export function expectedControlledDemoOrgName(phase: ControlledPhase): string {
  return PHASE_CONFIG[phase].orgName;
}

/** Every configured phase demo org ID must be unique and must not be HFAC. */
export function assertDistinctControlledDemoOrgIds(): void {
  const configured: Array<{ phase: ControlledPhase; orgId: string }> = [];
  for (const phase of ALL_PHASES) {
    const orgId = controlledDemoOrgIdFromEnv(phase);
    if (orgId) configured.push({ phase, orgId });
  }

  const ids = configured.map((row) => row.orgId);
  if (new Set(ids).size !== ids.length) {
    const dupes = ids.filter((id, index) => ids.indexOf(id) !== index);
    throw new Error(
      `Controlled phase demo org IDs must be distinct (duplicate: ${dupes[0] ?? "unknown"})`,
    );
  }

  for (const { orgId } of configured) {
    assertNotHfacOrganization(orgId);
    if (orgId === TELLER_HFAC_ORG_ID) {
      throw new Error("HFAC org cannot be used as a controlled phase demo org");
    }
  }
}

export function loadControlledDemoOrgId(phase: ControlledPhase): string {
  assertDistinctControlledDemoOrgIds();
  const orgId = controlledDemoOrgIdFromEnv(phase);
  if (!orgId) {
    throw new Error(`Missing ${PHASE_CONFIG[phase].envKey} for phase ${phase} controlled demo`);
  }
  assertNotHfacOrganization(orgId);
  return orgId;
}

/** Guard all destructive helpers — refuse writes outside the active phase demo org. */
export function assertMutationScope(
  orgId: string,
  allowedOrgId: string,
  context = "controlled demo mutation",
): void {
  if (orgId !== allowedOrgId) {
    throw new Error(`Refusing ${context} outside active phase demo org`);
  }
  assertNotHfacOrganization(orgId);
}

export function loadPriorPhasePeerOrgIds(
  activePhase: ControlledPhase,
): Partial<Record<ControlledPhase, string>> {
  const peers: Partial<Record<ControlledPhase, string>> = {};
  for (const phase of ALL_PHASES) {
    if (phase >= activePhase) continue;
    const orgId = controlledDemoOrgIdFromEnv(phase);
    if (orgId) peers[phase] = orgId;
  }
  return peers;
}

export async function assertDemoOrgName(
  supabase: SupabaseClient,
  orgId: string,
  expectedName: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("teller_organizations")
    .select("id, name")
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.name !== expectedName) {
    throw new Error(`Expected org "${expectedName}", got "${data?.name ?? "missing"}"`);
  }
}

export async function captureOrgEconomicFingerprint(
  supabase: SupabaseClient,
  orgId: string,
): Promise<OrgEconomicFingerprint> {
  async function count(table: string) {
    const { count, error } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    if (error) throw new Error(`${table}: ${error.message}`);
    return count ?? 0;
  }

  return {
    documents: await count("teller_documents"),
    journals: await count("teller_journal_entries"),
    jobs: await count("teller_jobs"),
  };
}

export async function capturePeerFingerprints(
  supabase: SupabaseClient,
  activePhase: ControlledPhase,
): Promise<Map<ControlledPhase, OrgEconomicFingerprint>> {
  const peers = loadPriorPhasePeerOrgIds(activePhase);
  const fingerprints = new Map<ControlledPhase, OrgEconomicFingerprint>();
  for (const [phaseKey, orgId] of Object.entries(peers)) {
    const phase = Number(phaseKey) as ControlledPhase;
    fingerprints.set(phase, await captureOrgEconomicFingerprint(supabase, orgId!));
  }
  return fingerprints;
}

export async function assertPeerFingerprintsUnchanged(
  supabase: SupabaseClient,
  before: Map<ControlledPhase, OrgEconomicFingerprint>,
  activePhase: ControlledPhase,
): Promise<void> {
  const peers = loadPriorPhasePeerOrgIds(activePhase);
  for (const [phaseKey, orgId] of Object.entries(peers)) {
    const phase = Number(phaseKey) as ControlledPhase;
    const expected = before.get(phase);
    if (!expected) continue;
    const after = await captureOrgEconomicFingerprint(supabase, orgId!);
    if (JSON.stringify(after) !== JSON.stringify(expected)) {
      throw new Error(`Phase ${phase} demo org mutated during phase ${activePhase} demo`);
    }
  }
}
