# Phase 17B — Security, RLS, Auth & Tenant Isolation Hardening

**Date:** 2026-09-12  
**Slice:** 17B  
**Baseline:** Phase 17A complete — no critical accounting blockers  
**Feature freeze:** active

---

## Executive Summary

Phase 17B hardens Teller's defense-in-depth security model. The primary verified gap was **migration 047 re-enabling direct journal INSERT RLS** (17A-003), allowing authenticated bookkeepers to bypass `teller_post_journal` balance and account-entity checks via Supabase client.

**Remediation prepared (manual application required):**

- `supabase/patches/051_phase17b_security_hardening.sql` — drops journal INSERT policies; restores RPC-only posting (migration 025 intent); adds probe RPC.

**Code remediation (17A-013):**

- Removed post-hoc `UPDATE` on posted journal lines in `fixed-asset-acquisition.ts`; linkage uses immutable `teller_fixed_asset_journal_links` table; reconciliation updated.

**Not changed (by design):**

- Zero-membership legacy entity access — inventoried, not migrated (requires explicit backfill plan).

---

## Threat Model

| Actor | Asset | Attack Surface | Current Control | Bypass Risk | Severity |
|-------|-------|----------------|-----------------|-------------|----------|
| A. Unauthenticated | Org data | `/api/*`, Supabase REST | Per-route auth; RLS | Route omitting guard | HIGH if route unguarded |
| B. Normal user | GL, documents | Browser client + API | Session + org RLS | IDOR via UUID guess | LOW (RLS) |
| C. Restricted entity user | Entity B data | Supabase REST, reports | Entity access fn + partial RLS | Org-only tables (bank tx, allocations) | MEDIUM |
| D. Owner/admin | All org entities | Full API surface | Role checks | Zero-membership N/A for admins | LOW |
| E. Malicious tenant | Other tenants | Cross-org IDs in API/RPC | Server-derived org; RLS | Service-role misuse in app | LOW |
| F. Compromised browser | Session token | Direct Supabase client | RLS + entity checks | Journal INSERT before 051 | **HIGH** |
| G. Webhook caller | HFAC org data | HFAC routes | HMAC + org mapping | Legacy bearer fallback | MEDIUM |
| H. Service-role backend | All tenants | RPC with null auth.uid() | Caller must validate org | Cron POST with secret | MEDIUM |
| I. Stolen session | Active org | Same as B/F | Session cookies + RLS | Until session revoked | MEDIUM |
| J. Replay | Webhook events | HFAC POST | Event ID dedup + timestamp | Legacy bearer mode | MEDIUM |

**Defense layers:** Auth → org membership → entity authorization → RLS → server validation → canonical RPC → audit.

---

## Authentication Model

| Field | Value |
|-------|-------|
| AUTHENTICATION_MODEL | Supabase Auth (email/password); SSR cookie session via `@supabase/ssr` |
| MFA_AVAILABLE | false |
| PRIVILEGED_MFA_REQUIRED | false (not implemented — finding 17B-006) |
| SESSION_VALIDATION | `middleware.ts` refreshes session; `getSessionContext()` validates user + profile |
| SESSION_FIXATION_RISK | LOW — Supabase-managed tokens |
| SESSION_REPLAY_RISK | LOW — standard cookie + refresh rotation |

**Gap:** Middleware protects `/app/*` pages only; `/api/*` routes self-guard (17B-001).

---

## Authorization Matrix

| Role | Org Access | Entity Access | Read Accounting | Post Accounting | Close Period | Manage Users | Manage Entities | Manage Banking | Manage Tax | Manage Integrations |
|------|------------|---------------|-----------------|-----------------|--------------|--------------|-----------------|----------------|------------|---------------------|
| owner | member | all entities | yes | yes | yes | yes | yes | yes | yes | yes |
| admin | member | all entities | yes | yes | yes | yes | yes | yes | yes | yes |
| bookkeeper | member | membership or legacy-all | yes | yes | no* | no | no | yes | partial | no |
| viewer | member | membership or legacy-all | yes | no | no | no | no | read | read | no |

*Period close requires owner/admin via `requireAccountingAdminBooks()`.

Entity access: `teller_can_access_legal_entity()` + app `canAccessLegalEntity()`.

---

## Cross-Org Isolation

| Check | Result |
|-------|--------|
| CROSS_ORG_READ | false — RLS `teller_is_org_member` on all `teller_*` tables |
| CROSS_ORG_INSERT | false — RLS WITH CHECK |
| CROSS_ORG_UPDATE | false — policies scoped to org |
| CROSS_ORG_DELETE | false — writer policies org-scoped |
| CROSS_ORG_RPC_EXECUTION | false — RPCs assert org ownership of referenced IDs |

API routes derive `organizationId` from session — never from client body (verified grep).

---

## Cross-Entity Isolation

| Check | Result |
|-------|--------|
| UNAUTHORIZED_ENTITY_READ | false on 047-hardened tables (accounts, documents, journals, payments, bank accounts) |
| UNAUTHORIZED_ENTITY_POST | false via `requireEntityBooks()` + RPC entity checks |
| UNAUTHORIZED_ENTITY_SETTINGS_CHANGE | false via `requireAdminBooks()` |

**Gap (17B-010):** Tables still org-only SELECT: `teller_bank_transactions`, `teller_payment_allocations`, `teller_write_offs`, `teller_tax_transactions`, `teller_parties`, `teller_jobs`. Restricted entity users may read cross-entity rows on these tables.

---

## Zero-Membership Legacy Access

| Field | Value |
|-------|-------|
| ZERO_MEMBERSHIP_USERS_COUNT | Production inventory via `verify-phase17b-production.mjs` |
| ZERO_MEMBERSHIP_ORGS_COUNT | Same probe |
| ZERO_MEMBERSHIP_SECURITY_RISK | MEDIUM — bookkeeper/viewer without membership rows sees all entities |
| ZERO_MEMBERSHIP_RECOMMENDATION | Defer strict mode to future slice with membership backfill + comms plan; **not changed in 17B** |

Logic: `041_phase16b_entity_access.sql` — `not teller_has_restricted_entity_access(p_org)` grants full entity visibility.

---

## RLS Inventory (Summary)

| Table | RLS | SELECT | INSERT | UPDATE | DELETE | Org | Entity | Notes |
|-------|-----|--------|--------|--------|--------|-----|--------|-------|
| teller_journal_entries | yes | entity | **removed by 051** | none | none | yes | yes | 047 regression fixed by 051 |
| teller_journal_lines | yes | entity | **removed by 051** | none | none | via entry | via entry | |
| teller_accounts | yes | entity | entity write | entity write | entity write | yes | yes | 047 |
| teller_documents | yes | entity | entity | entity | entity | yes | yes | 047 |
| teller_payments | yes | entity | entity | partial | none | yes | yes | 047 |
| teller_bank_accounts | yes | entity | entity | entity | entity | yes | yes | 047 |
| teller_bank_transactions | yes | org | writer | writer | writer | yes | **no** | 17B-010 |
| teller_payment_allocations | yes | org | writer | writer | writer | yes | **no** | 17B-010 |
| teller_hfac_webhook_events | yes | none | none | none | none | — | service role only | |
| teller_bank_connection_secrets | yes | none | none | none | none | — | service role only | |

**PERMISSIVE_RLS_WIDENING_FOUND:** false on hardened tables (047 uses drop-before-create).

---

## Journal INSERT RLS — 17A-003 Deep Dive

| Field | Pre-051 (production) | Post-051 (target) |
|-------|---------------------|-------------------|
| DIRECT_CLIENT_JOURNAL_INSERT_POSSIBLE | **true** — bookkeeper+ with entity access | **false** |
| DIRECT_CLIENT_JOURNAL_LINE_INSERT_POSSIBLE | **true** | **false** |
| CANONICAL_POSTING_BYPASS_POSSIBLE | **true** — unbalanced/wrong-account journals possible | **false** |
| JOURNAL_INSERT_RLS_ACTION | Apply patch 051 manually | RPC-only posting restored |

Period guard trigger still fires on any INSERT (including RPC path via SECURITY DEFINER bypass of RLS).

---

## Posted Journal Immutability

| Check | Result |
|-------|--------|
| DIRECT_POSTED_JOURNAL_UPDATE | false — no UPDATE policy |
| DIRECT_POSTED_JOURNAL_DELETE | false — no DELETE policy |
| DIRECT_POSTED_LINE_UPDATE | false — no UPDATE policy (17A-013 code fix removes app path) |
| DIRECT_POSTED_LINE_DELETE | false — no DELETE policy |

| Field | Value |
|-------|-------|
| POSTED_LINE_METADATA_MUTATION_REQUIRED | false — link table suffices |
| FIXED_ASSET_LINKAGE_REMEDIATION | `teller_fixed_asset_journal_links` + reconciliation reads link map |

---

## Integration / Webhook Security

| Check | Result |
|-------|--------|
| HFAC_HMAC | PASS |
| HFAC_REPLAY_PROTECTION | PASS (HMAC mode); partial in legacy bearer |
| HFAC_ORG_VALIDATION | PASS — external mapping authoritative |
| HFAC_EXTERNAL_ID_COLLISION_PROTECTION | PASS — integration config scoped per org |
| HFAC_CLIENT_CONTROLLED_ENTITY | false |

---

## RPC Security

~150 SECURITY DEFINER functions. Canonical pattern:

```sql
if auth.uid() is not null and not public.teller_can_write_books(p_organization_id) then
  raise exception 'Not authorized';
end if;
```

Service role (`auth.uid() is null`) skips auth — caller must validate org.

| Field | Value |
|-------|-------|
| UNSAFE_SECURITY_DEFINER_RPCS | 0 critical — org-ownership asserts present on accounting RPCs |
| UNSAFE_SECURITY_DEFINER_SEARCH_PATHS | 0 — core functions use `set search_path = public` |
| RPC_GRANTS_AUDITED | true — posting RPCs granted to authenticated + service_role (required for app) |

---

## Service Role Usage

| Path | Purpose | Safe? |
|------|---------|-------|
| `src/lib/supabase/admin.ts` | HFAC webhooks, controlled tests | yes — org resolved server-side |
| `src/lib/banking/sync.ts` | Plaid token storage | yes — no browser exposure |
| `src/app/api/cron/process-schedules/route.ts` | Scheduler | POST gated by secret; GET exposes config (17B-007) |

| Field | Value |
|-------|-------|
| SERVICE_ROLE_USAGE_AUDITED | true |
| UNSAFE_SERVICE_ROLE_PATHS | 0 critical |

---

## API / Server Action Authorization

162 API route files. Pattern: `requireBooks()` / entity variants derive org from session.

| Field | Value |
|-------|-------|
| UNAUTHENTICATED_SENSITIVE_API_ROUTES | 0 accounting routes (cron GET is low-severity config) |
| SERVER_ACTION_AUTHORIZATION | PASS — org from session |
| IDOR_FINDINGS_CRITICAL | 0 |
| IDOR_FINDINGS_HIGH | 0 |
| MASS_ASSIGNMENT_SECURITY | PASS — no client org_id trusted |

---

## Privilege Escalation

| Check | Result |
|-------|--------|
| SELF_ROLE_ESCALATION | false — `teller_profiles_role_guard` trigger |
| SELF_ENTITY_ACCESS_ESCALATION | false — admin-only entity membership API |

---

## Other Security Areas

| Area | Result |
|------|--------|
| ACTIVE_ENTITY_SECURITY | PASS — `requireEntityBooks()` revalidates |
| DEFAULT_ENTITY_CHANGE_AUTHORIZATION | PASS — admin routes |
| HFAC_DEFAULT_ENTITY_PROTECTION | PASS |
| PERIOD_CLOSE_AUTHORIZATION | PASS — owner/admin |
| PERIOD_REOPEN_AUTHORIZATION | PASS — owner/admin |
| SECURITY_SENSITIVE_AUDIT_COVERAGE | PARTIAL — role/entity changes logged; gaps remain (17E) |
| STORAGE_TENANT_ISOLATION | NOT_APPLICABLE / minimal |
| IMPORT_SECURITY | PASS — server-validated |
| EXPORT_TENANT_ISOLATION | PASS — org/entity scoped |
| SENSITIVE_ERROR_DISCLOSURE | false |
| SECRETS_COMMITTED | false |
| ENVIRONMENT_SEPARATION | PASS — HFAC org guarded in controlled tests |
| RATE_LIMITING_COVERAGE | PARTIAL — no global rate limits |
| CSRF_RISK | LOW — SameSite cookies + JSON API |
| SENSITIVE_INPUT_VALIDATION | PASS — Zod on major routes |
| CROSS_TENANT_FK_INVARIANT_COVERAGE | PARTIAL — org asserts in RPC; composite FKs deferred |

---

## Changes Delivered

### Manual DB patch (STOP — user must apply)

**File:** `supabase/patches/051_phase17b_security_hardening.sql`

- Drops journal INSERT policies from 047
- Adds `teller_phase17b_journal_insert_blocked()` probe
- Static verify: `npm run verify:patch:051:static`

### Application code

- `fixed-asset-acquisition.ts` — removed posted line UPDATE
- `fixed-assets.ts` — `loadFixedAssetJournalLinkByEntry()`
- `fixed-asset-reconciliation.ts` — attribution via link table
- `unassigned-fixed-asset-activity.ts` — excludes linked entries

### Tooling

- `scripts/controlled-phase17b-security-acceptance.ts`
- `scripts/verify-phase17b-production.mjs`
- `src/lib/security/phase17b.test.ts`

---

## Findings Register

| ID | Severity | Description | Target |
|----|----------|-------------|--------|
| 17B-001 | MEDIUM | API routes not middleware-protected | Document; optional future middleware |
| 17B-002 | HIGH | Journal INSERT RLS bypass (17A-003) | **Patch 051** |
| 17B-003 | MEDIUM | Zero-membership legacy full entity access | Future backfill slice |
| 17B-004 | INFO | SECURITY DEFINER skips auth for service role | By design; audit callers |
| 17B-005 | MEDIUM | HFAC legacy bearer default ON | HFAC rollout doc |
| 17B-006 | LOW | MFA not implemented | Future |
| 17B-007 | LOW | Cron GET unauthenticated | Optional hardening |
| 17B-008 | LOW | Org-scoped routes without entity filter | 17B-010 |
| 17B-009 | MEDIUM | Fixed asset posted line UPDATE (17A-013) | **Code fix** |
| 17B-010 | MEDIUM | Entity RLS gaps on bank tx, allocations, etc. | 17B follow-up patch |

---

## Acceptance & Verification

```bash
npm run verify:patch:051:static
# After manual patch application:
TELLER_CONTROLLED_PROD_TEST=1 npm run verify:phase17b:production
TELLER_CONTROLLED_PROD_TEST=1 npm run accept:phase17b:controlled -- --rerun-2
TELLER_TEST_PHASE=17 npm run test:phase
npm run test:full
```

---

## Sign-off

| Flag | Value |
|------|-------|
| PATCH_051_APPLIED | true (manual) |
| PATCH_051_PROBE | `teller_phase17b_journal_insert_blocked()` = true |
| NEW_SQL_PATCH_REQUIRED | false (051 applied) |
| MANUAL_PATCH_FILE | `supabase/patches/051_phase17b_security_hardening.sql` |
| HFAC_BASELINE | 8 documents, 17 journals (unchanged) |
| PRODUCTION_JOURNALS | 1664 checked, 0 unbalanced |
| PHASE17B_PRODUCTION_VERIFY | PASS |
| PHASE17B_CONTROLLED_ACCEPTANCE | 38/38 ×2 PASS |
| PHASE_17B_CODE_COMPLETE | true |
| PHASE_17B_DB_VERIFIED | true |
| PHASE_17B_COMPLETE | true |
