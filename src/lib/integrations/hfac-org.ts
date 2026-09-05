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

export async function recordHfacWebhookEventId(
  supabase: SupabaseClient,
  input: {
    eventId: string;
    organizationId?: string | null;
    route: string;
    authMode: string;
  },
): Promise<boolean> {
  const { error } = await supabase.from("teller_hfac_webhook_events").insert({
    event_id: input.eventId,
    organization_id: input.organizationId ?? null,
    route: input.route,
    auth_mode: input.authMode,
  });

  if (error?.message.includes("duplicate")) return true;
  if (error) throw new Error(error.message);
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
