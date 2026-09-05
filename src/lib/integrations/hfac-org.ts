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

function configExternalId(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;
  const row = config as Record<string, unknown>;
  const candidates = [row.external_account_id, row.hfac_company_id, row.company_id];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
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

async function assertHfacIntegrationActive(
  supabase: SupabaseClient,
  organizationId: string,
) {
  const { data: integrations, error } = await supabase
    .from("teller_integrations")
    .select("provider, enabled, config")
    .eq("organization_id", organizationId)
    .in("provider", [...HFAC_PROVIDERS]);

  if (error) throw new Error(error.message);

  const active = (integrations ?? []).some(
    (row) => row.enabled && (row.provider === "hfac" || row.provider === "hasslefreeac"),
  );
  if (!active) {
    throw new HfacOrgRejectedError(
      "inactive_integration",
      "HFAC integration is not active for this organization",
    );
  }
}

async function findOrgByHfacExternalId(
  supabase: SupabaseClient,
  externalId: string,
): Promise<string | null> {
  const { data: integrations, error } = await supabase
    .from("teller_integrations")
    .select("organization_id, provider, enabled, config")
    .in("provider", [...HFAC_PROVIDERS])
    .eq("enabled", true);

  if (error) throw new Error(error.message);

  for (const row of integrations ?? []) {
    const mapped = configExternalId(row.config);
    if (mapped === externalId) return row.organization_id as string;
  }
  return null;
}

/** Persist HFAC external id on the integration record when first seen. */
export async function rememberHfacExternalId(
  supabase: SupabaseClient,
  organizationId: string,
  externalId: string,
) {
  const { data: integration } = await supabase
    .from("teller_integrations")
    .select("id, config")
    .eq("organization_id", organizationId)
    .eq("provider", "hfac")
    .maybeSingle();

  if (!integration) return;

  const config =
    integration.config && typeof integration.config === "object"
      ? (integration.config as Record<string, unknown>)
      : {};

  if (configExternalId(config) === externalId) return;

  await supabase
    .from("teller_integrations")
    .update({
      config: {
        ...config,
        external_account_id: externalId,
        hfac_company_id: externalId,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", integration.id);
}

export async function resolveHfacWebhookOrganization(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<{ organizationId: string; externalAccountId?: string }> {
  const externalId = extractHfacExternalId(body);
  const claimedOrgId =
    typeof body.organizationId === "string" ? body.organizationId.trim() : null;

  if (externalId) {
    let organizationId = await findOrgByHfacExternalId(supabase, externalId);

    if (!organizationId && claimedOrgId) {
      await assertHfacIntegrationActive(supabase, claimedOrgId);
      await rememberHfacExternalId(supabase, claimedOrgId, externalId);
      organizationId = claimedOrgId;
    }

    if (!organizationId) {
      throw new HfacOrgRejectedError(
        "unknown_external_organization",
        "No Teller organization is linked to this HFAC account",
      );
    }

    if (claimedOrgId && claimedOrgId !== organizationId) {
      throw new HfacOrgRejectedError(
        "organization_mismatch",
        "HFAC account does not match the claimed Teller organization",
      );
    }

    await assertHfacIntegrationActive(supabase, organizationId);
    return { organizationId, externalAccountId: externalId };
  }

  if (!claimedOrgId) {
    throw new HfacOrgRejectedError(
      "missing_organization",
      "organizationId or HFAC company identity is required",
    );
  }

  const { data: org, error: orgError } = await supabase
    .from("teller_organizations")
    .select("id")
    .eq("id", claimedOrgId)
    .maybeSingle();

  if (orgError) throw new Error(orgError.message);
  if (!org) {
    throw new HfacOrgRejectedError("unknown_organization", "Organization not found");
  }

  await assertHfacIntegrationActive(supabase, claimedOrgId);
  return { organizationId: claimedOrgId };
}

export async function auditHfacWebhookRejected(
  supabase: SupabaseClient,
  input: {
    organizationId?: string | null;
    reason: string;
    route: string;
  },
) {
  if (!input.organizationId) return;
  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    action: "hfac.webhook.rejected",
    resourceKind: "integration",
    metadata: { reason: input.reason, route: input.route },
  });
}

export async function auditHfacWebhookAccepted(
  supabase: SupabaseClient,
  organizationId: string,
  route: string,
) {
  await recordAuditEvent(supabase, {
    organizationId,
    action: "hfac.webhook.accepted",
    resourceKind: "integration",
    metadata: { route },
  });
}

/** Constant-time digest compare for webhook secrets (future HMAC support). */
export function secureCompare(expected: string, received: string): boolean {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const receivedDigest = createHash("sha256").update(received).digest();
  return timingSafeEqual(expectedDigest, receivedDigest);
}
