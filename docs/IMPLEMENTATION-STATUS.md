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
| HFAC integration | Manual sync button + webhooks; not real-time for all events | Event-driven hooks in HFAC on Stripe sync |
| Immutability | Journal UPDATE/DELETE blocked; period close not yet | Accounting period close / lock |
| Settings UX | Company + accounting editable in Settings | Locations UI, team invites |
| Integration adapters | HFAC-specific code paths | Extract `IntegrationProvider` interface |
| Tests | Balance, reversal, roles, org config, HFAC import | Tenant isolation integration tests |

## Not started (spec-aligned backlog)

| Priority | Item |
|----------|------|
| High | Accounting period close / lock |
| High | Data export (GL CSV, transaction export) |
| Medium | Granular permissions beyond four roles |
| Medium | MFA requirement for owner/admin |
| Medium | Rate limiting on auth + webhooks |
| Medium | Banking adapter (Plaid read-only) |
| Medium | Jurisdiction / tax configuration engine |
| Low | AI categorization with human review gate |
| Low | SOC 2 / formal compliance program |

## Explicit non-goals for V1

- Bank credential storage
- ACH / wire origination
- Native payment processing / merchant of record
- Payroll processing
- Shared database with HFAC
