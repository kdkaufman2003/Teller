-- Phase 16H: Entity-level accounting controls — RLS hardening.
-- Replaces org-only permissive policies on core economic tables with entity-aware access.
-- Manual apply only. Safe to re-run (idempotent drops before create).

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

drop policy if exists "teller members manage accounts" on public.teller_accounts;
drop policy if exists "teller members read accounts" on public.teller_accounts;
drop policy if exists "teller writers manage accounts" on public.teller_accounts;
drop policy if exists "teller entity accounts select" on public.teller_accounts;
drop policy if exists "teller entity accounts write" on public.teller_accounts;

create policy "teller entity accounts select"
  on public.teller_accounts for select
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_access_legal_entity(organization_id, legal_entity_id)
  );

create policy "teller entity accounts write"
  on public.teller_accounts for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
    and public.teller_can_access_legal_entity(organization_id, legal_entity_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
    and public.teller_can_access_legal_entity(organization_id, legal_entity_id)
  );

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------

drop policy if exists "teller members manage documents" on public.teller_documents;
drop policy if exists "teller members read documents" on public.teller_documents;
drop policy if exists "teller writers manage documents" on public.teller_documents;
drop policy if exists "teller writers update documents" on public.teller_documents;
drop policy if exists "teller entity documents select" on public.teller_documents;
drop policy if exists "teller entity documents insert" on public.teller_documents;
drop policy if exists "teller entity documents update" on public.teller_documents;

create policy "teller entity documents select"
  on public.teller_documents for select
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_access_legal_entity(organization_id, legal_entity_id)
  );

create policy "teller entity documents insert"
  on public.teller_documents for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
    and public.teller_can_access_legal_entity(organization_id, legal_entity_id)
  );

create policy "teller entity documents update"
  on public.teller_documents for update
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
    and public.teller_can_access_legal_entity(organization_id, legal_entity_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
    and public.teller_can_access_legal_entity(organization_id, legal_entity_id)
  );

drop policy if exists "teller members manage document lines" on public.teller_document_lines;
drop policy if exists "teller members read document lines" on public.teller_document_lines;
drop policy if exists "teller writers manage document lines" on public.teller_document_lines;
drop policy if exists "teller entity document lines select" on public.teller_document_lines;
drop policy if exists "teller entity document lines write" on public.teller_document_lines;

create policy "teller entity document lines select"
  on public.teller_document_lines for select
  using (
    exists (
      select 1
      from public.teller_documents d
      where d.id = document_id
        and public.teller_is_org_member(d.organization_id)
        and public.teller_can_access_legal_entity(d.organization_id, d.legal_entity_id)
    )
  );

create policy "teller entity document lines write"
  on public.teller_document_lines for all
  using (
    exists (
      select 1
      from public.teller_documents d
      where d.id = document_id
        and public.teller_is_org_member(d.organization_id)
        and public.teller_can_write_books(d.organization_id)
        and public.teller_can_access_legal_entity(d.organization_id, d.legal_entity_id)
    )
  )
  with check (
    exists (
      select 1
      from public.teller_documents d
      where d.id = document_id
        and public.teller_is_org_member(d.organization_id)
        and public.teller_can_write_books(d.organization_id)
        and public.teller_can_access_legal_entity(d.organization_id, d.legal_entity_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Journal entries / lines
-- ---------------------------------------------------------------------------

drop policy if exists "teller members manage journal entries" on public.teller_journal_entries;
drop policy if exists "teller members read journal entries" on public.teller_journal_entries;
drop policy if exists "teller writers insert journal entries" on public.teller_journal_entries;
drop policy if exists "teller entity journal entries select" on public.teller_journal_entries;
drop policy if exists "teller entity journal entries insert" on public.teller_journal_entries;

create policy "teller entity journal entries select"
  on public.teller_journal_entries for select
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_access_legal_entity(organization_id, legal_entity_id)
  );

create policy "teller entity journal entries insert"
  on public.teller_journal_entries for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
    and public.teller_can_access_legal_entity(organization_id, legal_entity_id)
  );

drop policy if exists "teller members manage journal lines" on public.teller_journal_lines;
drop policy if exists "teller members read journal lines" on public.teller_journal_lines;
drop policy if exists "teller writers insert journal lines" on public.teller_journal_lines;
drop policy if exists "teller entity journal lines select" on public.teller_journal_lines;
drop policy if exists "teller entity journal lines insert" on public.teller_journal_lines;

create policy "teller entity journal lines select"
  on public.teller_journal_lines for select
  using (
    exists (
      select 1
      from public.teller_journal_entries e
      where e.id = entry_id
        and public.teller_is_org_member(e.organization_id)
        and public.teller_can_access_legal_entity(e.organization_id, e.legal_entity_id)
    )
  );

create policy "teller entity journal lines insert"
  on public.teller_journal_lines for insert
  with check (
    exists (
      select 1
      from public.teller_journal_entries e
      where e.id = entry_id
        and public.teller_is_org_member(e.organization_id)
        and public.teller_can_write_books(e.organization_id)
        and public.teller_can_access_legal_entity(e.organization_id, e.legal_entity_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------

drop policy if exists "teller members read payments" on public.teller_payments;
drop policy if exists "teller writers insert payments" on public.teller_payments;
drop policy if exists "teller entity payments select" on public.teller_payments;
drop policy if exists "teller entity payments insert" on public.teller_payments;

create policy "teller entity payments select"
  on public.teller_payments for select
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_access_legal_entity(organization_id, legal_entity_id)
  );

create policy "teller entity payments insert"
  on public.teller_payments for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
    and public.teller_can_access_legal_entity(organization_id, legal_entity_id)
  );

-- ---------------------------------------------------------------------------
-- Bank accounts
-- ---------------------------------------------------------------------------

drop policy if exists "teller members read bank accounts" on public.teller_bank_accounts;
drop policy if exists "teller writers manage bank accounts" on public.teller_bank_accounts;
drop policy if exists "teller entity bank accounts select" on public.teller_bank_accounts;
drop policy if exists "teller entity bank accounts write" on public.teller_bank_accounts;

create policy "teller entity bank accounts select"
  on public.teller_bank_accounts for select
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_access_legal_entity(organization_id, legal_entity_id)
  );

create policy "teller entity bank accounts write"
  on public.teller_bank_accounts for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
    and public.teller_can_access_legal_entity(organization_id, legal_entity_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
    and public.teller_can_access_legal_entity(organization_id, legal_entity_id)
  );

-- ---------------------------------------------------------------------------
-- Acceptance probe (callable via Supabase RPC — no direct DB URL required)
-- ---------------------------------------------------------------------------

create or replace function public.teller_phase16h_controls_applied()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'teller_accounts'
      and policyname = 'teller entity accounts select'
  )
  and exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'teller_documents'
      and policyname = 'teller entity documents select'
  )
  and exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'teller_journal_entries'
      and policyname = 'teller entity journal entries select'
  )
  and exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'teller_payments'
      and policyname = 'teller entity payments select'
  )
  and exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'teller_bank_accounts'
      and policyname = 'teller entity bank accounts select'
  )
  and not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'teller_accounts'
      and policyname = 'teller members read accounts'
  );
$$;

grant execute on function public.teller_phase16h_controls_applied() to authenticated, service_role;
