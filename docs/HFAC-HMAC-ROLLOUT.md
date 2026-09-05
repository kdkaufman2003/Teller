# HFAC HMAC Webhook Rollout Plan

Phase 0.5 introduced signed HFAC webhooks and strict external-account mapping. Use this sequence before disabling legacy bearer authentication in production.

## Required HFAC payload fields

Every production webhook must include:

- `companyId` (or equivalent HFAC external account ID)
- HMAC headers:
  - `X-Teller-Event-Id`
  - `X-Teller-Timestamp` (Unix seconds)
  - `X-Teller-Signature`

Signature:

```text
HMAC-SHA256(
  TELLER_HFAC_WEBHOOK_SECRET,
  timestamp + "." + event_id + "." + raw_request_body
)
```

Optional consistency check:

- `organizationId` in body must match the mapped Teller organization (never authoritative on its own)

## Rollout sequence

### Step 1 — Teller deploy (dual mode)

- Deploy Phase 0 + 0.5 + 0.6 code
- Apply migrations `012` and `013`
- Keep defaults:
  - `TELLER_HFAC_WEBHOOK_LEGACY_BEARER=true`
  - `TELLER_HFAC_REQUIRE_EXTERNAL_MAPPING=true`

### Step 2 — HFAC begins sending HMAC

- HFAC sends all three signature headers on every webhook
- HFAC includes `companyId` on every webhook
- Monitor Teller audit events:
  - `hfac.webhook.accepted` with `authMode: hmac`
  - `hfac.webhook.rejected`

### Step 3 — Verify signed production events

- Confirm accepted events show `authMode: hmac` in audit metadata
- Confirm no duplicate `X-Teller-Event-Id` replays create duplicate business records
- Run `npm run hfac:integration-report` and resolve unmapped integrations

### Step 4 — Populate external mappings

For each active HFAC integration:

```json
teller_integrations.config.external_account_id = "<HFAC company id>"
teller_integrations.config.status = "active"
```

Or use `setHfacExternalMapping()` operationally.

Requirements:

- Every active production integration must be **mapped**
- No duplicate `external_account_id` across organizations (CRITICAL)

### Step 5 — Monitor rejected webhooks

Watch for:

- `missing_external_id`
- `unknown_external_organization`
- `organization_mismatch`
- `stale_timestamp`
- `invalid_signature`

Resolve before disabling bearer fallback.

### Step 6 — Disable legacy bearer

Set in production:

```env
TELLER_HFAC_WEBHOOK_LEGACY_BEARER=false
```

Redeploy Teller.

### Step 7 — Verify bearer-only requests are rejected

- Send a test webhook with bearer auth only (no HMAC headers)
- Expect HTTP `401 Unauthorized`
- Confirm audit log does **not** create business records

## Do not

- Leave dual-mode authentication enabled indefinitely
- Disable bearer before all active integrations are mapped
- Trust body `organizationId` without external mapping
- Run legacy payment backfill in production without a dry run first

## Operational commands

```bash
npm run verify:migrations
npm run hfac:integration-report
ORGANIZATION_ID=<uuid> npm run legacy:payment-audit
ORGANIZATION_ID=<uuid> npm run legacy:payment-backfill          # dry run
ORGANIZATION_ID=<uuid> APPLY=1 npm run legacy:payment-backfill  # apply
RUN_INTEGRATION_TESTS=1 npm run test:integration
```

Admin integrity check (owner/admin session):

```http
GET /api/accounting/integrity?legacyAudit=1
```

Read-only. Does not modify accounting records.
