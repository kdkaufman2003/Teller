-- Phase 17D: evidence-based read-path indexes.
-- Manual application only. No data mutation.

-- Reversal lookup (void checks, trial balance, subledger)
create index if not exists teller_journal_entries_reverses_entry_idx
  on public.teller_journal_entries (reverses_entry_id)
  where reverses_entry_id is not null;

-- Vendor/customer document lists
create index if not exists teller_documents_org_party_kind_date_idx
  on public.teller_documents (organization_id, party_id, kind, issue_date desc);

-- Entity-scoped document lists (invoices, dashboard)
create index if not exists teller_documents_org_entity_kind_date_idx
  on public.teller_documents (organization_id, legal_entity_id, kind, issue_date desc);

-- Job-attributed documents
create index if not exists teller_documents_org_job_kind_idx
  on public.teller_documents (organization_id, job_id, kind)
  where job_id is not null;

-- Party-scoped payment history
create index if not exists teller_payments_org_party_type_date_idx
  on public.teller_payments (organization_id, party_id, payment_type, payment_date desc);

-- Allocation sums by payment (N+1 mitigation)
create index if not exists teller_payment_allocations_payment_id_idx
  on public.teller_payment_allocations (payment_id);

-- Org-wide bank status queues (sync, tab counts)
create index if not exists teller_bank_transactions_org_status_date_idx
  on public.teller_bank_transactions (organization_id, status, posted_date desc);

-- Per-resource audit history
create index if not exists teller_audit_events_org_resource_created_idx
  on public.teller_audit_events (organization_id, resource_kind, resource_id, created_at desc);

-- Schedule occurrence date filters (close readiness)
create index if not exists teller_schedule_occurrences_org_status_date_idx
  on public.teller_schedule_occurrences (organization_id, status, occurrence_date);

create or replace function public.teller_phase17d_performance_probe()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'teller_journal_entries_reverses_entry_idx'
  )
  and exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'teller_documents_org_party_kind_date_idx'
  )
  and exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'teller_bank_transactions_org_status_date_idx'
  );
end;
$$;

grant execute on function public.teller_phase17d_performance_probe() to authenticated, service_role;
