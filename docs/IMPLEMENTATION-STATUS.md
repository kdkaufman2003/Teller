# Implementation status

Maps [SPEC.md](./SPEC.md) to the codebase as of V1 development. Update this when closing gaps.

## Implemented

| Area | Status | Location |
|------|--------|----------|
| Multi-tenant org model | ✓ | `teller_organizations`, all `teller_*` tables |
| Row Level Security | ✓ | `supabase/migrations/001_teller_core.sql` |
| Double-entry ledger | ✓ | `teller_journal_entries`, `post.ts`, `assertBalanced()` |
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
| Role enforcement | RLS allows all members equal write access | Add role checks in API + policies |
| HFAC integration | Manual sync button + webhooks; not real-time for all events | Event-driven hooks in HFAC on Stripe sync |
| Immutability | Posted entries editable via RLS | Period locks, restrict UPDATE on posted entries |
| Integration adapters | HFAC-specific code paths | Extract `IntegrationProvider` interface |
| Tests | HFAC import + subscriber tests | Add tenant isolation + balance tests |

## Not started (spec-aligned backlog)

| Priority | Item |
|----------|------|
| High | `teller_audit_events` append-only audit log |
| High | Accounting period close / lock |
| High | Reversal and void journal workflow |
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
