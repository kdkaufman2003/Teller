# Implementation status

Maps [SPEC.md](./SPEC.md) to the codebase as of V1 development. Update this when closing gaps.

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
| Void / reversal workflow | ✓ (Phase 1) | `voidInvoice()`, `reverseJournalEntry()` |
| Journal immutability | ✓ (Phase 1) | RLS insert-only on journal tables; `005_accounting_foundation.sql` |
| Industry packs + setup | ✓ | Setup wizard, `teller_industry_settings` |
| Session-scoped API access | ✓ | `requireBooks()`, `getSessionContext()` |
| HFAC optional integration | ✓ | `src/lib/integrations/hfac*.ts`, webhook routes |
| Standalone operation | ✓ | No HFAC env required |
| Partner webhook auth | ✓ | `hfac-auth.ts`, bearer secret |
| Service role for inbound webhooks | ✓ | `createServiceClient()` on integration routes |
| Basic roles | ✓ | `owner`, `admin`, `bookkeeper`, `viewer` |

## Partial

| Area | Gap | Next step |
|------|-----|-----------|
| Role enforcement | ✓ (Phase 1) | `requireWriteBooks()`, RLS `teller_can_write_books()`, role trigger |
| HFAC integration | Manual sync button + webhooks; structured won-deal metadata | Event-driven hooks in HFAC; post estimated COGS to GL |
| Partial payments | Cumulative `amount_paid`, open until fully paid | Payment UI, customer statements |
| Jurisdiction tax rules | Engine + loader ready; `taxMode: jurisdiction` optional | Authoritative MO/KS rule specs after professional review |
| Bank reconciliation UI | Import + match suggestions; confirm/ignore | Statement balance reconciliation, period close |
| Health engine | Score + attention on dashboard | Anomaly detection, period-close gates |
| Immutability | Journal UPDATE/DELETE blocked; period close not yet | Accounting period close / lock |
| Settings UX | Company + accounting editable in Settings | Locations UI, team invites |
| Integration adapters | HFAC-specific code paths | Extract `IntegrationProvider` interface |
| Tests | Balance, reversal, roles, org config, HFAC import | Tenant isolation integration tests |

## Not started (spec-aligned backlog)

| Priority | Item |
|----------|------|
| High | Accounting period close / lock |
| Medium | Granular permissions beyond four roles |
| Medium | MFA requirement for owner/admin |
| Medium | Rate limiting on auth + webhooks |
| Medium | Authoritative MO/KS tax rule packs (populate engine after review) |
| Medium | Full bank reconciliation (statement balances, period lock) |
| Low | AI categorization with human review gate |
| Low | SOC 2 / formal compliance program |

## Explicit non-goals for V1

- Bank credential storage
- ACH / wire origination
- Native payment processing / merchant of record
- Payroll processing
- Shared database with HFAC
