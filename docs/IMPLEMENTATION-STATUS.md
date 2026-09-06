# Implementation status

Maps [SPEC.md](./SPEC.md) to the codebase as of V1 development. Update this when closing gaps.

## Phase completion flags

| Flag | Value | Verified |
|------|-------|----------|
| `PHASE_7_COMPLETE` | **true** | Migration 023 applied; deploy `faa6bb9`; controlled prod 45/45 Phase 7 demo, 32/32 Phase 6, 18/18 Phase 5; GL revenue/cost reconciliation difference $0.00; HFAC baseline unchanged |
| `PHASE_6_COMPLETE` | **true** | Controlled prod: 32/32 Phase 6 demo scenarios (incl. 10 accounting/control cases), Phase 5 verify+demo green, HFAC baseline unchanged (8 docs, 3 payments, 16 journals) |

### Phase 7 invariants (job costing)

- Jobs are **analytical dimensions** over the GL — not a parallel ledger.
- **Economic** revenue/cost journal lines may carry `job_id` and `cost_classification`.
- **Settlement/control** lines (AR, AP, cash/bank clearing on payments) do **not** drive job profitability.
- Customer/vendor **payments do not create** revenue or direct cost.
- **Customer deposits** are liability movements — not revenue until applied to invoices.
- **Purchase orders** represent commitment; actual cost posts on bills/expenses only.
- Canonical job profitability reconciles to GL activity within explicit revenue/direct-cost scope (`GL_*_DIFFERENCE = 0.00` in controlled demo).
- **Labor payroll** job costing remains deferred (no payroll engine in V1).
- Legacy job status values remain temporarily accepted in migration 023 for deploy compatibility; cleanup migration deferred.

### Phase 7 deferred polish

| Item | Notes |
|------|-------|
| Customer detail related-jobs panel | UI deferred from Phase 7 MVP |
| Legacy job status cleanup migration | Remove temporary dual status CHECK after deploy window |

## Implemented

| Area | Status | Location |
|------|--------|----------|
| Multi-tenant org model | ✓ | `teller_organizations`, all `teller_*` tables |
| Row Level Security | ✓ | `supabase/migrations/001_teller_core.sql` |
| Double-entry ledger | ✓ | `teller_journal_entries`, `post.ts`, `assertBalanced()`, `teller_post_journal` RPC |
| Audit log | ✓ (Phase 1) | `teller_audit_events`, `audit.ts` |
| Organization configuration | ✓ (Phase 2) | `006_org_configuration.sql`, `/api/settings`, `org/config.ts` |
| Intelligent onboarding | ✓ (Phase 3) | `onboarding.ts`, branching setup wizard |
| HVAC industry profile | ✓ (Phase 4) | Residential/commercial COA, job detail P&L, dashboard labels |
| HFAC structured integration | ✓ (Phase 5) | `007_payments_idempotency.sql`, `teller_payments`, idempotency keys, partial payments, quote COGS metadata |
| Jurisdiction tax engine | ✓ (Phase 6) | `008_tax_engine.sql`, `src/lib/tax/`, `tax-rules/` spec + loader; no MO/KS rules shipped |
| Banking adapter (read-only) | ✓ (Phase 7) | `009_banking.sql`, `src/lib/banking/`, Plaid Link, transaction import + match suggestions |
| Accounting health engine | ✓ (Phase 8) | `src/lib/health/`, dashboard score + needs-attention list, `/api/health` |
| Advanced reporting | ✓ (Phase 9) | `financial-reports.ts`, balance sheet, cash flow, AR/AP aging tabs on `/app/reports` |
| Advanced accounting | ✓ (Phase 10) | `010_accounting_periods.sql`, period close, CPA mode, CSV exports, manual adjustments on `/app/accounting` |
| Intelligence / automation | ✓ (Phase 11) | `011_intelligence.sql`, `src/lib/intelligence/`, dashboard narrative + scan suggestions with human review |
| Void / reversal workflow | ✓ (Phase 1) | `voidInvoice()`, `reverseJournalEntry()` |
| Journal immutability | ✓ (Phase 1) | RLS insert-only on journal tables; `005_accounting_foundation.sql` |
| Industry packs + setup | ✓ | Setup wizard, `teller_industry_settings` |
| Session-scoped API access | ✓ | `requireBooks()`, `getSessionContext()` |
| HFAC optional integration | ✓ | `src/lib/integrations/hfac*.ts`, webhook routes |
| Standalone operation | ✓ | No HFAC env required |
| Partner webhook auth | ✓ | `hfac-auth.ts`, bearer secret |
| Service role for inbound webhooks | ✓ | `createServiceClient()` on integration routes |
| Basic roles | ✓ | `owner`, `admin`, `bookkeeper`, `viewer` |
| Accounts payable & purchasing (Phase 6) | ✓ | Migrations 021–022, vendors, PO/receiving, multi-bill pay, vendor credits, recurring bills, AP dashboard; controlled prod demo covers multi-bill payment, over-allocation rejection, multi-bill credit apply, bank→bill_payment match (no extra journal), closed-period bill/payment rejection, tenant isolation, PO receipt/bill controls, approval rejection |
| Job costing & profitability (Phase 7) | ✓ | Migration 023, atomic job numbering, line-level job attribution on invoices/expenses/bills, cost categories/budgets, lifecycle APIs, jobs UI, canonical profitability + GL bridge; `postBillOpen` persists document lines; settlement lines exclude `job_id` |

## Partial

| Area | Gap | Next step |
|------|-----|-----------|
| Role enforcement | ✓ (Phase 1) | `requireWriteBooks()`, RLS `teller_can_write_books()`, role trigger |
| HFAC integration | Manual sync button + webhooks; structured won-deal metadata | Event-driven hooks in HFAC; post estimated COGS to GL |
| Partial payments | Cumulative `amount_paid`, open until fully paid | Payment UI, customer statements |
| Jurisdiction tax rules | Engine + loader ready; `taxMode: jurisdiction` optional | Authoritative MO/KS rule specs after professional review |
| Bank reconciliation UI | Import + match suggestions; confirm/ignore | Statement balance reconciliation, period close |
| Health engine | Score + attention on dashboard | Anomaly detection wired via intelligence scan |
| Immutability | Journal UPDATE/DELETE blocked; period close locks posting dates | Reopen workflow + adjustment audit trail |
| Settings UX | Company + accounting editable in Settings | Locations UI, team invites |
| Integration adapters | HFAC-specific code paths | Extract `IntegrationProvider` interface |
| Tests | Balance, reversal, roles, org config, HFAC import | Tenant isolation integration tests |

## Not started (spec-aligned backlog)

| Priority | Item |
|----------|------|
| Medium | Granular permissions beyond four roles |
| Medium | MFA requirement for owner/admin |
| Medium | Rate limiting on auth + webhooks |
| Medium | Authoritative MO/KS tax rule packs (populate engine after review) |
| Medium | Full bank reconciliation (statement balances, period lock) |
| Low | SOC 2 / formal compliance program |

## Explicit non-goals for V1

- Bank credential storage
- ACH / wire origination
- Native payment processing / merchant of record
- Payroll processing
- Shared database with HFAC
