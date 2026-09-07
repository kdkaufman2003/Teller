# Teller — Product, Architecture & Security Specification

This document is the north star for Teller. It governs product boundaries, architecture, and security expectations. **Teller is standalone first.** Hassle Free AC (HFAC) is an optional integration — never a dependency.

---

## 1. Product definition

Teller is a standalone, multi-tenant bookkeeping and accounting SaaS.

**Purpose:** Make business bookkeeping simple, understandable, automated, and industry-specific.

**Requirements:**

- Sellable independently across industries, states, and territories.
- Architecture anticipates national scale without premature financial-services complexity.
- HFAC may integrate; Teller must operate fully without it.

---

## 2. Core philosophy

Teller is **not** a bank and should not unnecessarily hold sensitive financial credentials.

**Goal:** Powerful accounting infrastructure underneath an extremely simple user experience.

- Industry terminology, workflows, dashboards, and automation layer on a **standardized, auditable** core engine.
- The UI can be simple; the ledger cannot be simplistic.

**North star:** *"Tell me what happened in my business, keep my books correct, and show me what I need to know."*

---

## 3. V1 product boundary

### V1 may include

- Chart of accounts, general ledger, double-entry journal entries
- Customers, vendors, jobs (industry modules), invoices, expenses
- Accounts receivable / payable workflows where appropriate
- Industry packs (HVAC, trades, SaaS, general)
- Optional HFAC integration (subscribers, billing, won deals, payments)
- Future: bank import via third-party providers (Plaid, etc.) — read-only
- Future: AI-assisted categorization and bookkeeping suggestions
- Export / portability (CSV, GL, reports)
- Complete audit history (target state)

### V1 must not include

- Storing bank usernames or passwords
- Holding customer funds, acting as a bank, originating ACH/wires
- Moving money between customer accounts
- Issuing cards, processing payroll directly
- Collecting customer payments directly (unless deliberately added later)
- Becoming merchant of record (unless deliberately added later)

Money movement is a **separate trust boundary** requiring its own security, legal, and fraud review — not a bookkeeping feature extension.

---

## 4. Teller and Hassle Free AC

HFAC and Teller are **separate products** with separate repos, Supabase projects, and security boundaries.

```
HFAC → Stripe → HFAC records payment → authenticated webhook → Teller → journal entry
```

**Rules:**

- Integration via authenticated APIs/webhooks only — no shared database access.
- Teller receives accounting facts, not HFAC's full data model.
- HFAC failure must not break Teller; Teller failure must not break HFAC.
- A breach in one app must not automatically expose the other's database.
- HFAC auth does **not** grant Teller access — separate org membership and sessions.

**Current webhooks:** `/api/integrations/hfac/subscribers`, `quotes`, `payments`, `billing`

---

## 5. Multi-tenant architecture

Every business is an **Organization**. Every sensitive row includes `organization_id`.

**Tenant isolation:**

- Enforced server-side on every API route (`requireBooks()` → session org).
- Enforced at database level via Supabase RLS (`teller_is_org_member`).
- Never rely on UI alone to hide data.

Cross-tenant access is a **critical security failure**. Never accept `organizationId` from the browser for user-scoped operations — derive from session. (Inbound partner webhooks are the exception: org id in signed payload + shared secret.)

---

## 6. Users and access control

**Current roles:** `owner`, `admin`, `bookkeeper`, `viewer` (`teller_profiles.role`)

**Target evolution:** Granular permissions (`transactions.read`, `ledger.write`, `integrations.manage`, etc.)

Use least privilege. External CPAs get controlled, time-bounded access.

---

## 7. Authentication

Use Supabase Auth — do not roll custom password crypto.

**Target:** MFA for privileged admins, session revocation, rate limiting, secure cookies, CSRF where applicable.

Never expose service role or webhook secrets to client code.

---

## 8. Banking integrations (future)

Never collect bank login credentials. Use approved providers (Plaid, Finicity, MX) behind a **Banking Adapter** with **read-only** scopes until money movement is explicitly in scope.

---

## 9. Integration architecture

Core accounting logic must not be tightly coupled to providers. Use adapters:

```
Accounting Core → Payments Adapter → Stripe / HFAC
Accounting Core → Banking Adapter → Plaid (future)
Accounting Core → Business Adapter → HFAC
```

See `src/lib/integrations/` — inbound HFAC handlers import into core posting functions in `src/lib/accounting/post.ts`.

---

## 10. Accounting engine

**Double-entry only.** Every posted entry must balance: total debits = total credits.

**Core objects (implemented):**

| Object | Table |
|--------|-------|
| Accounts | `teller_accounts` |
| Parties (customers/vendors) | `teller_parties` |
| Documents (invoices, expenses) | `teller_documents` + `teller_document_lines` |
| Journal entries | `teller_journal_entries` + `teller_journal_lines` |
| Integrations | `teller_integrations` |

**Planned:** accounting periods, fiscal year locks, formal reversals, bank reconciliations, attachments.

Do not replace the ledger with a flat income/expense table.

---

## 11. Immutable accounting history

Posted entries should not be silently overwritten. Corrections use reversals, adjustments, or void workflows — each leaving an audit trail.

**Implemented (Phase 1 + Phase 9):** Journal UPDATE/DELETE blocked by RLS; posting flows through `teller_post_journal` and domain RPCs. Closed periods reject new journals dated on or before `teller_books_closed_through(org)` via RPC check and a `BEFORE INSERT` trigger on `teller_journal_entries`. Close/reopen events are append-only (`teller_period_closes`); reopening the latest closed month requires owner/admin + reason. Adjusting entries use workflow metadata (`teller_adjusting_journal_entries`) and post through canonical `teller_post_journal` with `source_kind: adjustment`.

---

## 12. Audit logging (target)

Log security and accounting events: auth, permission changes, integrations, posting, voids, exports, period close.

Audit records: org, user, event, timestamp, resource, before/after where appropriate.

**Never log:** passwords, tokens, bank credentials, full card numbers.

**Current gap:** No `teller_audit_events` table yet — add before SOC 2 / enterprise sales.

---

## 13. Encryption and secrets

- TLS in transit (Vercel + Supabase default).
- Encryption at rest (Supabase managed).
- Secrets in env / Vercel — never in Git, never in client bundles, never in logs.
- Rotate webhook secrets and API keys on compromise or schedule.

---

## 14. Data minimization

Collect only what bookkeeping requires. Define retention and deletion policies as the product matures.

Payment storage: accounting representation + Stripe/HFAC external IDs — not PAN, CVV, or bank passwords.

---

## 15. AI security (future)

AI may suggest categorizations and explanations; it must not:

- Bypass permission checks
- Directly mutate posted ledger without normal controls
- Receive unnecessary PII, tax IDs, or credentials

Human review above confidence thresholds for auto-posting.

---

## 16. Industry configuration

**Core engine + industry layer** — not separate apps per vertical.

Industry packs define: chart of accounts seeds, labels, modules, setup questions, revenue/expense categories, dashboards (future).

Implemented: `teller_industry_settings`, industry packs in setup wizard, `revenueCodeForItemType()`.

---

## 17. Regional / jurisdiction (future)

Do not hard-code Kansas/Missouri. Jurisdiction config: country, state, tax rules, fiscal year, currency, timezone — via a rules engine, not scattered `if (state === 'KS')`.

---

## 18. Security standards (design for, don't claim)

Engineer toward SOC 2, OWASP ASVS, NIST SSDF, FTC Safeguards / GLBA where applicable, PCI scope minimization, state privacy laws.

Do not claim compliance until assessments are complete.

---

## 19. Secure software development

- Separate dev / staging / production
- No production financial data in dev without sanitization
- Dependency scanning, secret scanning, code review, automated tests
- **Required tests:** tenant isolation, authorization, accounting balance integrity, webhook auth

---

## 20. Database security

- RLS on all tenant tables ✓
- Service role server-only for setup webhooks and admin paths ✓
- Financial writes server-side ✓
- Use DB transactions for multi-step posting (target: wrap `postInvoiceOpen` + lines in transactions)
- Foreign keys and check constraints ✓

---

## 21. API security

Every endpoint verifies:

1. Authentication
2. Organization membership
3. Authorization (role — expand later)
4. Resource ownership (`organization_id` match)
5. Input validity

Webhooks: verify `Authorization: Bearer` shared secret (`hfacWebhookAuthorized`).

Rate limiting: target for auth and webhook endpoints.

---

## 22. Payment information from Stripe / HFAC

Store accounting entries + external references (`stripePaymentIntentId`, `hfacInvoiceId`) — not card data.

---

## 23–25. Operations (target)

Backups / PITR (Supabase), disaster recovery runbooks, observability (auth failures, webhook failures, reconciliation errors), incident response plan.

---

## 26. Data export and portability

Customers must be able to export GL, transactions, customers, reports. Architecture should not trap data.

**Current gap:** Limited export — add CSV/GL export before GA marketing to accountants.

---

## 27. Security boundary with HFAC

Separate sessions, org membership, roles, audit logs. Optional link in UI only — not SSO that skips Teller authorization.

---

## 28. Future money movement

Invoicing with native payment collection, ACH, bill pay, payroll, cards — each requires separate review before implementation.

---

## 29. Mandatory rules for AI coding agents

1. Never weaken auth or tenant isolation for convenience.
2. Never disable RLS without explicit architectural approval.
3. Never put secrets in client code or Git.
4. Never log credentials or full payment details.
5. Never collect bank passwords.
6. Never trust client-supplied org ownership.
7. Never overwrite posted history — use reversals/adjustments.
8. Never let AI bypass permissions.
9. Never request financial API scopes beyond need.
10. Never use production data in dev without sanitization.
11. Never break double-entry for UI shortcuts.
12. Never trust webhooks without verification.
13. Never implement money movement because an API makes it easy.
14. If a feature conflicts with these rules, stop and flag the conflict.

---

## 30. Architectural principle

Teller may eventually hold complete financial records for thousands of businesses. Evaluate auth, integrations, storage, and accounting decisions accordingly — without unnecessary complexity in the customer UI.
