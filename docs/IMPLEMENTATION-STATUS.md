# Implementation status

Maps [SPEC.md](./SPEC.md) to the codebase as of V1 development. Update this when closing gaps.

## Phase completion flags

| Flag | Value | Verified |
|------|-------|----------|
| `PHASE_10_COMPLETE` | **true** | Migration 026 manually applied; deploy `dpl_6fLHJCy9Hjjog1JZzezGugFEcMX1` → `https://teller-indol.vercel.app`; controlled prod 110/110 Phase 10, Phase 5–9 regressions green; HFAC unchanged; 192/192 journals balanced |
| `PHASE_9_COMPLETE` | **true** | Migration 025 applied; deploy `fc54b96`; controlled prod 102/102 Phase 9 demo, 67/67 Phase 8, 45/45 Phase 7, 32/32 Phase 6, 18/18 Phase 5; HFAC baseline unchanged; production journals balanced (192 entries) |
| `PHASE_8_COMPLETE` | **true** | Migration 024 applied (schema-wide); controlled prod 67/67 Phase 8 demo (post-025 regression), 45/45 Phase 7, 32/32 Phase 6, 18/18 Phase 5; GL fixed-asset cost/accum/expense reconciliation difference $0.00; HFAC baseline unchanged; disposal idempotency + atomic RPC verified |
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
| Advanced reporting | ✓ (historical label — see naming note below) | `financial-reports.ts`, balance sheet, cash flow, AR/AP aging tabs on `/app/reports` |
| Accounting periods (migration 010) | ✓ (historical label “Phase 10”) | `010_accounting_periods.sql`, CPA mode, CSV exports, legacy `/app/accounting` |
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
| Fixed assets & depreciation (Phase 8) | ✓ | Migration 024, FA subledger + GL bridge, straight-line schedules, batch/single depreciation, atomic disposal RPC with UUID idempotency, assets UI, controlled prod 67/67 |

### Phase naming note (historical drift)

- **Advanced reporting** was labeled Phase 9 in early docs — it shipped before month-end close.
- **Migration 010** (accounting periods) was labeled Phase 10 — do not renumber that migration.
- **Current roadmap Phase 9** = month-end close, adjusting entries, and accounting controls (`025_phase9_month_end_close.sql`).

### Phase 9 — month-end close (production complete)

| Area | Status | Location |
|------|--------|----------|
| Immutable close/reopen history | ✓ prod | Append-only `teller_period_closes` events; legacy DELETE → reopen trigger for Phase 8 app |
| Accounting state watermark | ✓ prod | `teller_accounting_state_versions`; close validates `expectedAccountingVersion` + `expectedCloseStateVersion` |
| Journal direct-insert hardening | ✓ prod | No generic period-lock bypass; advisory lock on all journal inserts |
| Close readiness engine | ✓ prod | `src/lib/accounting/close-readiness.ts` |
| Reconciliation aggregation | ✓ prod | `src/lib/accounting/close-reconciliation-summary.ts` |
| Org-wide job GL reconciliation | ✓ prod | `src/lib/accounting/org-job-reconciliation.ts` |
| Trial balance (full GL scope) | ✓ prod | `src/lib/accounting/trial-balance.ts`, `/app/accounting/trial-balance` |
| Adjusting journal workflow | ✓ prod | `teller_adjusting_journal_entries`, multi-line composer, `/app/accounting/adjustments` |
| Recurring journal templates | ✓ prod | `teller_recurring_journal_templates`, draft-only generation |
| Derived retained earnings | ✓ prod | `derived-retained-earnings.ts` — fiscal-year-aware; **no** year-end closing journals |
| Close UI | ✓ prod | `/app/accounting/close`, period detail, checklist APIs |
| Controlled harness | ✓ prod | `setup:phase9-demo-org`, `verify:phase9:controlled`, `demo:phase9:controlled` (102 scenarios), `audit:phase9:deployment-compat` |

**Controlled production acceptance (2026-09-07):** migration `025_phase9_month_end_close.sql` applied; `demo:phase9:controlled` **102/102**; Phase 5–8 regressions green; HFAC baseline unchanged (8 docs, 3 payments, 16 journals, AR $1,500.00, AP $0.00).

**Deferred Phase 9.1:** dedicated prepaid/accrual schedules, auto-post recurring journals, comparative TB columns, AJE attachments.

### Phase 10 — financial reporting (production complete)

| Area | Status | Location |
|------|--------|----------|
| Cash flow classification | ✓ prod | `026_phase10_financial_reporting.sql`, `cash-flow-report.ts` |
| Report line groups + mappings | ✓ prod | `teller_report_line_groups`, `teller_account_report_mappings` |
| GL aggregation RPC | ✓ prod | `teller_gl_account_totals`, `gl-account-totals.ts` |
| P&L / balance sheet / cash flow | ✓ prod | `report-engine.ts`, `/app/reports`, `/api/reports/*` |
| Comparative reporting | ✓ prod | `comparative-reports.ts` |
| GL pagination + drilldown | ✓ prod | `/app/ledger`, `/app/reports/account/[accountId]` |
| Customer/vendor balances | ✓ prod | `/app/reports/customer-balances`, `/app/reports/vendor-balances` |
| 1099 review + sales tax summary | ✓ prod | `/app/accounting/tax/*` |
| Accountant package | ✓ prod | `/api/reports/accountant-package` |
| Accounting integrity + close checklist | ✓ prod | `/app/accounting/integrity`, `CloseChecklistPanel.tsx` |
| Presentation mode (owner/accountant) | ✓ prod | `presentation-mode.ts` |
| Controlled harness | ✓ prod | `demo:phase10:controlled` (110 scenarios), `audit:phase10:deployment-compat` |

**Controlled production acceptance (2026-09-07):** migration `026_phase10_financial_reporting.sql` manually applied; `demo:phase10:controlled` **110/110**; Phase 5–9 regressions green; cross-phase isolation hardened; HFAC baseline unchanged; production journals **192/192** balanced. Deploy: `https://teller-indol.vercel.app` (`dpl_6fLHJCy9Hjjog1JZzezGugFEcMX1`). Details: [PHASE-10-COMPLETION.md](./PHASE-10-COMPLETION.md).

**Deferred Phase 10.1:** custom report line editor UI, cash-basis P&L on live settlements in prod UI, report PDF/email delivery.

### Phase 8 invariants (fixed assets)

- Fixed assets are a **subledger** over the GL — journal lines remain the accounting source of truth.
- **Acquisition** posts to GL once (cash/AP, linked bill, capitalization, or opening balance); linking backfills `fixed_asset_id` on existing FA debit lines.
- **Depreciation** posts Dr expense / Cr accumulated depreciation with `fixed_asset_id`; disposal catch-up depreciation is separate from the disposal journal.
- **Disposal** is atomic via `teller_dispose_fixed_asset`; client-supplied `operationId` (UUID) is required and reused on retry; undo reverses disposal journal only (not depreciation).
- GL reconciliation bridge: `GL_FIXED_ASSET_COST_DIFFERENCE`, `GL_ACCUMULATED_DEPRECIATION_DIFFERENCE`, `GL_DEPRECIATION_EXPENSE_DIFFERENCE` = $0.00 in controlled demo.
- HFAC org (`812be00d-3084-4227-ac71-ccbd22e4172c`) is read-only in all controlled demos.

### Phase 8 deferred polish

| Item | Notes |
|------|-------|
| Bill line → create asset flow | UI convenience; non-blocking |
| `verify:phase8:post-migration` pg grant checks | Requires `SUPABASE_DB_URL` in controlled prod env |

## Partial

| Area | Gap | Next step |
|------|-----|-----------|
| Role enforcement | ✓ (Phase 1) | `requireWriteBooks()`, RLS `teller_can_write_books()`, role trigger |
| HFAC integration | Manual sync button + webhooks; structured won-deal metadata | Event-driven hooks in HFAC; post estimated COGS to GL |
| Partial payments | Cumulative `amount_paid`, open until fully paid | Payment UI, customer statements |
| Jurisdiction tax rules | Engine + loader ready; `taxMode: jurisdiction` optional | Authoritative MO/KS rule specs after professional review |
| Immutability | Journal UPDATE/DELETE blocked; period close locks posting dates via DB trigger + RPC | Reopen requires reason; AJE workflow replaces legacy 2-line adjustment |
| Bank reconciliation UI | Import + match suggestions; confirm/ignore | Required-bank-for-close settings in `teller_close_settings` |
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
| Low | SOC 2 / formal compliance program |

## Explicit non-goals for V1

- Bank credential storage
- ACH / wire origination
- Native payment processing / merchant of record
- Payroll processing
- Shared database with HFAC
