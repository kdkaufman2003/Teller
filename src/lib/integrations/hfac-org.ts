import { createHash, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAuditEvent } from "@/lib/accounting/audit";

const HFAC_PROVIDERS = ["hfac", "hasslefreeac", "quoter"] as const;

export class HfacOrgRejectedError extends Error {
  reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = "HfacOrgRejectedError";
    this.reason = reason;
  }
}

export function hfacRequireExternalMapping(): boolean {
  const flag = process.env.TELLER_HFAC_REQUIRE_EXTERNAL_MAPPING?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "no") return false;
  return true;
}

export function configExternalId(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;
  const row = config as Record<string, unknown>;
  const candidates = [row.external_account_id, row.hfac_company_id, row.company_id];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function integrationStatus(config: unknown, enabled: boolean): "active" | "inactive" {
  if (!enabled) return "inactive";
  if (!config || typeof config !== "object") return "active";
  const status = (config as Record<string, unknown>).status;
  if (status === "inactive") return "inactive";
  return "active";
}

/** Extract HFAC-side organization identity from webhook payload. */
export function extractHfacExternalId(body: Record<string, unknown>): string | null {
  const topLevel = [
    body.companyId,
    body.hfacOrganizationId,
    body.dealerAccountId,
    body.externalAccountId,
  ];
  for (const value of topLevel) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  const nestedKeys = ["payment", "quote", "entry", "subscriber"] as const;
  for (const key of nestedKeys) {
    const nested = body[key];
    if (!nested || typeof nested !== "object") continue;
    const row = nested as Record<string, unknown>;
    const nestedCandidates = [
      row.companyId,
      row.hfacOrganizationId,
      row.dealerAccountId,
      row.dealer_account_id,
      row.externalAccountId,
    ];
    for (const value of nestedCandidates) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }

  return null;
}

type IntegrationRow = {
  organization_id: string;
  provider: string;
  enabled: boolean;
  config: unknown;
};

async function loadHfacIntegrations(
  supabase: SupabaseClient,
  filter?: { organizationId?: string; externalId?: string },
): Promise<IntegrationRow[]> {
  let query = supabase
    .from("teller_integrations")
    .select("organization_id, provider, enabled, config")
    .in("provider", [...HFAC_PROVIDERS]);

  if (filter?.organizationId) {
    query = query.eq("organization_id", filter.organizationId);
  }
  if (filter?.externalId === undefined && !filter?.organizationId) {
    query = query.eq("enabled", true);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  let rows = (data ?? []) as IntegrationRow[];
  if (filter?.externalId) {
    rows = rows.filter((row) => configExternalId(row.config) === filter.externalId);
  }
  return rows;
}

function assertIntegrationUsable(row: IntegrationRow) {
  if (!row.enabled) {
    throw new HfacOrgRejectedError(
      "inactive_integration",
      "HFAC integration is disabled for this organization",
    );
  }
  if (integrationStatus(row.config, row.enabled) === "inactive") {
    throw new HfacOrgRejectedError(
      "inactive_integration",
      "HFAC integration mapping is inactive",
    );
  }
  if (row.provider !== "hfac" && row.provider !== "hasslefreeac") {
    throw new HfacOrgRejectedError(
      "inactive_integration",
      "No active HFAC integration provider found",
    );
  }
}

async function findOrgByHfacExternalId(
  supabase: SupabaseClient,
  externalId: string,
): Promise<IntegrationRow | null> {
  const rows = await loadHfacIntegrations(supabase, { externalId });
  const match = rows.find(
    (row) =>
      row.enabled &&
      integrationStatus(row.config, row.enabled) === "active" &&
      (row.provider === "hfac" || row.provider === "hasslefreeac"),
  );
  return match ?? null;
}

/** Admin/migration helper — pre-populate mapping; not used during webhook resolution. */
export async function setHfacExternalMapping(
  supabase: SupabaseClient,
  organizationId: string,
  externalId: string,
) {
  const { data: integration, error } = await supabase
    .from("teller_integrations")
    .select("config")
    .eq("organization_id", organizationId)
    .eq("provider", "hfac")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!integration) {
    throw new Error("HFAC integration record not found for organization");
  }

  const config =
    integration.config && typeof integration.config === "object"
      ? (integration.config as Record<string, unknown>)
      : {};

  const { error: updateError } = await supabase
    .from("teller_integrations")
    .update({
      enabled: true,
      config: {
        ...config,
        external_account_id: externalId,
        hfac_company_id: externalId,
        status: "active",
      },
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", organizationId)
    .eq("provider", "hfac");

  if (updateError) throw new Error(updateError.message);
}

export async function resolveHfacWebhookOrganization(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<{ organizationId: string; externalAccountId: string }> {
  const externalId = extractHfacExternalId(body);
  const claimedOrgId =
    typeof body.organizationId === "string" ? body.organizationId.trim() : null;

  if (!externalId) {
    if (hfacRequireExternalMapping()) {
      throw new HfacOrgRejectedError(
        "missing_external_id",
        "HFAC company/account ID is required",
      );
    }
    throw new HfacOrgRejectedError(
      "missing_external_id",
      "HFAC company/account ID is required; legacy organizationId-only webhooks are disabled",
    );
  }

  const integration = await findOrgByHfacExternalId(supabase, externalId);
  if (!integration) {
    throw new HfacOrgRejectedError(
      "unknown_external_organization",
      "No active Teller organization is linked to this HFAC account",
    );
  }

  assertIntegrationUsable(integration);

  const organizationId = integration.organization_id;
  if (claimedOrgId && claimedOrgId !== organizationId) {
    throw new HfacOrgRejectedError(
      "organization_mismatch",
      "Payload organizationId does not match the mapped Teller organization",
    );
  }

  return { organizationId, externalAccountId: externalId };
}

export type HfacIntegrationReportRow = {
  organizationId: string;
  organizationName: string | null;
  provider: string;
  enabled: boolean;
  status: "active" | "inactive" | "invalid";
  externalAccountId: string | null;
  mapping: "mapped" | "unmapped" | "inactive";
};

export async function buildHfacIntegrationReport(
  supabase: SupabaseClient,
): Promise<{
  total: number;
  mapped: number;
  unmapped: number;
  inactive: number;
  invalid: number;
  rows: HfacIntegrationReportRow[];
}> {
  const { data: integrations, error } = await supabase
    .from("teller_integrations")
    .select("organization_id, provider, enabled, config")
    .in("provider", ["hfac", "hasslefreeac"]);

  if (error) throw new Error(error.message);

  const orgIds = [...new Set((integrations ?? []).map((row) => row.organization_id as string))];
  const { data: orgs } = orgIds.length
    ? await supabase.from("teller_organizations").select("id, name").in("id", orgIds)
    : { data: [] as { id: string; name: string }[] };

  const orgNames = new Map((orgs ?? []).map((row) => [row.id, row.name]));

  const rows: HfacIntegrationReportRow[] = (integrations ?? [])
    .filter((row) => row.provider === "hfac" || row.provider === "hasslefreeac")
    .map((row) => {
      const externalAccountId = configExternalId(row.config);
      const status = !row.enabled
        ? "inactive"
        : integrationStatus(row.config, row.enabled) === "inactive"
          ? "inactive"
          : externalAccountId
            ? "active"
            : "invalid";

      const mapping = !row.enabled || status === "inactive"
        ? "inactive"
        : externalAccountId
          ? "mapped"
          : "unmapped";

      return {
        organizationId: row.organization_id as string,
        organizationName: orgNames.get(row.organization_id as string) ?? null,
        provider: row.provider as string,
        enabled: Boolean(row.enabled),
        status,
        externalAccountId,
        mapping,
      };
    });

  return {
    total: rows.length,
    mapped: rows.filter((row) => row.mapping === "mapped").length,
    unmapped: rows.filter((row) => row.mapping === "unmapped").length,
    inactive: rows.filter((row) => row.mapping === "inactive").length,
    invalid: rows.filter((row) => row.status === "invalid").length,
    rows,
  };
}

export type HfacWebhookClaimResult =
  | { kind: "new" }
  | { kind: "duplicate_processed" }
  | { kind: "retry" };

/** Claim webhook event for processing; failed events may be retried (Phase 17C). */
export async function claimHfacWebhookEvent(
  supabase: SupabaseClient,
  input: {
    eventId: string;
    route: string;
    authMode: string;
  },
): Promise<HfacWebhookClaimResult> {
  const { error } = await supabase.from("teller_hfac_webhook_events").insert({
    event_id: input.eventId,
    organization_id: null,
    route: input.route,
    auth_mode: input.authMode,
    processing_status: "pending",
  });

  if (!error) return { kind: "new" };
  if (!error.message.includes("duplicate")) throw new Error(error.message);

  const { data: existing, error: readError } = await supabase
    .from("teller_hfac_webhook_events")
    .select("processing_status")
    .eq("event_id", input.eventId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!existing) return { kind: "new" };

  if (existing.processing_status === "processed") {
    return { kind: "duplicate_processed" };
  }

  const { error: reclaimError } = await supabase
    .from("teller_hfac_webhook_events")
    .update({ processing_status: "pending", last_error: null })
    .eq("event_id", input.eventId)
    .in("processing_status", ["failed", "pending"]);
  if (reclaimError) throw new Error(reclaimError.message);
  return { kind: "retry" };
}

export async function markHfacWebhookProcessed(
  supabase: SupabaseClient,
  input: { eventId: string; organizationId: string },
) {
  const { error } = await supabase
    .from("teller_hfac_webhook_events")
    .update({
      organization_id: input.organizationId,
      processing_status: "processed",
      processed_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("event_id", input.eventId);
  if (error) throw new Error(error.message);
}

export async function markHfacWebhookFailed(
  supabase: SupabaseClient,
  input: { eventId: string; organizationId?: string | null; errorMessage: string },
) {
  const { error } = await supabase
    .from("teller_hfac_webhook_events")
    .update({
      organization_id: input.organizationId ?? null,
      processing_status: "failed",
      last_error: input.errorMessage.slice(0, 500),
    })
    .eq("event_id", input.eventId);
  if (error) throw new Error(error.message);
}

/** @deprecated use claimHfacWebhookEvent — legacy insert-only helper */
export async function recordHfacWebhookEventId(
  supabase: SupabaseClient,
  input: {
    eventId: string;
    organizationId?: string | null;
    route: string;
    authMode: string;
  },
): Promise<boolean> {
  const claim = await claimHfacWebhookEvent(supabase, input);
  if (claim.kind === "duplicate_processed") return true;
  if (input.organizationId) {
    await supabase
      .from("teller_hfac_webhook_events")
      .update({ organization_id: input.organizationId })
      .eq("event_id", input.eventId);
  }
  return false;
}

export async function auditHfacWebhookRejected(
  supabase: SupabaseClient,
  input: {
    organizationId?: string | null;
    reason: string;
    route: string;
    authReason?: string;
  },
) {
  const orgId = input.organizationId?.trim();
  if (!orgId) return;
  await recordAuditEvent(supabase, {
    organizationId: orgId,
    action: "hfac.webhook.rejected",
    resourceKind: "integration",
    metadata: {
      reason: input.reason,
      route: input.route,
      authReason: input.authReason ?? null,
    },
  });
}

export async function auditHfacWebhookAccepted(
  supabase: SupabaseClient,
  organizationId: string,
  route: string,
  authMode: string,
) {
  await recordAuditEvent(supabase, {
    organizationId,
    action: "hfac.webhook.accepted",
    resourceKind: "integration",
    metadata: { route, authMode },
  });
}

/** Constant-time digest compare for tests. */
export function secureCompare(expected: string, received: string): boolean {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const receivedDigest = createHash("sha256").update(received).digest();
  return timingSafeEqual(expectedDigest, receivedDigest);
}

/** @deprecated use setHfacExternalMapping during migration */
export const rememberHfacExternalId = setHfacExternalMapping;
