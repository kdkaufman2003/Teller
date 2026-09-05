-- Phase 1: audit trail, journal immutability, role protection, atomic posting

-- ---------------------------------------------------------------------------
-- Audit events (append-only)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_audit_events (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  actor_id uuid references auth.users (id) on delete set null,
  action text not null,
  resource_kind text not null,
  resource_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists teller_audit_events_org_idx
  on public.teller_audit_events (organization_id, created_at desc);

alter table public.teller_audit_events enable row level security;

create policy "teller members read audit events"
  on public.teller_audit_events for select
  using (public.teller_is_org_member(organization_id));

create policy "teller members insert audit events"
  on public.teller_audit_events for insert
  with check (
    public.teller_is_org_member(organization_id)
    and (actor_id is null or actor_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- Journal integrity columns
-- ---------------------------------------------------------------------------

alter table public.teller_journal_entries
  add column if not exists posted_at timestamptz not null default now(),
  add column if not exists reverses_entry_id uuid references public.teller_journal_entries (id) on delete set null;

alter table public.teller_documents
  drop constraint if exists teller_documents_posted_entry_id_fkey;

alter table public.teller_documents
  add constraint teller_documents_posted_entry_id_fkey
  foreign key (posted_entry_id) references public.teller_journal_entries (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Role helpers
-- ---------------------------------------------------------------------------

create or replace function public.teller_user_role(p_org uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.teller_profiles
  where id = auth.uid()
    and organization_id = p_org
  limit 1;
$$;

create or replace function public.teller_can_write_books(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select role in ('owner', 'admin', 'bookkeeper')
      from public.teller_profiles
      where id = auth.uid()
        and organization_id = p_org
      limit 1
    ),
    false
  );
$$;

-- Prevent users from changing their own role or non-admins from changing roles
create or replace function public.teller_prevent_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return NEW;
  end if;

  if OLD.role is distinct from NEW.role then
    if OLD.id = auth.uid() then
      raise exception 'Cannot change your own role';
    end if;
    if not exists (
      select 1
      from public.teller_profiles
      where id = auth.uid()
        and organization_id = NEW.organization_id
        and role in ('owner', 'admin')
    ) then
      raise exception 'Only owners and admins can change roles';
    end if;
  end if;

  return NEW;
end;
$$;

drop trigger if exists teller_profiles_role_guard on public.teller_profiles;
create trigger teller_profiles_role_guard
  before update on public.teller_profiles
  for each row execute function public.teller_prevent_role_escalation();

-- ---------------------------------------------------------------------------
-- Journal immutability — read all members, insert writers only, no update/delete
-- ---------------------------------------------------------------------------

drop policy if exists "teller members manage journal entries" on public.teller_journal_entries;
drop policy if exists "teller members manage journal lines" on public.teller_journal_lines;

create policy "teller members read journal entries"
  on public.teller_journal_entries for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers insert journal entries"
  on public.teller_journal_entries for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller members read journal lines"
  on public.teller_journal_lines for select
  using (
    exists (
      select 1 from public.teller_journal_entries e
      where e.id = entry_id
        and public.teller_is_org_member(e.organization_id)
    )
  );

create policy "teller writers insert journal lines"
  on public.teller_journal_lines for insert
  with check (
    exists (
      select 1 from public.teller_journal_entries e
      where e.id = entry_id
        and public.teller_is_org_member(e.organization_id)
        and public.teller_can_write_books(e.organization_id)
    )
  );

-- Viewers: read-only on operational tables (no insert/update/delete)
drop policy if exists "teller members manage documents" on public.teller_documents;
drop policy if exists "teller members manage document lines" on public.teller_document_lines;
drop policy if exists "teller members manage accounts" on public.teller_accounts;
drop policy if exists "teller members manage parties" on public.teller_parties;
drop policy if exists "teller members manage jobs" on public.teller_jobs;

create policy "teller members read documents"
  on public.teller_documents for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage documents"
  on public.teller_documents for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller writers update documents"
  on public.teller_documents for update
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller members read document lines"
  on public.teller_document_lines for select
  using (
    exists (
      select 1 from public.teller_documents d
      where d.id = document_id
        and public.teller_is_org_member(d.organization_id)
    )
  );

create policy "teller writers manage document lines"
  on public.teller_document_lines for all
  using (
    exists (
      select 1 from public.teller_documents d
      where d.id = document_id
        and public.teller_is_org_member(d.organization_id)
        and public.teller_can_write_books(d.organization_id)
    )
  )
  with check (
    exists (
      select 1 from public.teller_documents d
      where d.id = document_id
        and public.teller_is_org_member(d.organization_id)
        and public.teller_can_write_books(d.organization_id)
    )
  );

create policy "teller members read accounts"
  on public.teller_accounts for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage accounts"
  on public.teller_accounts for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller members read parties"
  on public.teller_parties for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage parties"
  on public.teller_parties for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller members read jobs"
  on public.teller_jobs for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage jobs"
  on public.teller_jobs for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- Integrations: writers only
drop policy if exists "teller members manage integrations" on public.teller_integrations;

create policy "teller members read integrations"
  on public.teller_integrations for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage integrations"
  on public.teller_integrations for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Atomic journal posting (entry + lines in one transaction)
-- ---------------------------------------------------------------------------

create or replace function public.teller_post_journal(
  p_organization_id uuid,
  p_entry_date date,
  p_memo text,
  p_source_kind text,
  p_source_id uuid,
  p_reverses_entry_id uuid,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry_id uuid;
  v_line jsonb;
  v_debit numeric(14, 2);
  v_credit numeric(14, 2);
  v_total_debit numeric(14, 2) := 0;
  v_total_credit numeric(14, 2) := 0;
begin
  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to post journal entries';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Journal entry requires at least one line';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_debit := coalesce((v_line->>'debit')::numeric, 0);
    v_credit := coalesce((v_line->>'credit')::numeric, 0);
    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;
  end loop;

  if abs(v_total_debit - v_total_credit) > 0.009 then
    raise exception 'Journal entry is unbalanced: debit % vs credit %', v_total_debit, v_total_credit;
  end if;

  insert into public.teller_journal_entries (
    organization_id,
    entry_date,
    memo,
    source_kind,
    source_id,
    reverses_entry_id
  ) values (
    p_organization_id,
    p_entry_date,
    coalesce(p_memo, ''),
    p_source_kind,
    p_source_id,
    p_reverses_entry_id
  )
  returning id into v_entry_id;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    insert into public.teller_journal_lines (
      entry_id,
      account_id,
      debit,
      credit,
      party_id,
      job_id,
      memo
    ) values (
      v_entry_id,
      (v_line->>'account_id')::uuid,
      coalesce((v_line->>'debit')::numeric, 0),
      coalesce((v_line->>'credit')::numeric, 0),
      nullif(v_line->>'party_id', '')::uuid,
      nullif(v_line->>'job_id', '')::uuid,
      coalesce(v_line->>'memo', '')
    );
  end loop;

  return v_entry_id;
end;
$$;

grant execute on function public.teller_post_journal(uuid, date, text, text, uuid, uuid, jsonb)
  to authenticated, service_role;

-- Settings and org profile: viewers read-only
drop policy if exists "teller members update own org" on public.teller_organizations;
drop policy if exists "teller members manage settings" on public.teller_industry_settings;

create policy "teller writers update own org"
  on public.teller_organizations for update
  using (
    public.teller_is_org_member(id)
    and public.teller_can_write_books(id)
  );

create policy "teller members read settings"
  on public.teller_industry_settings for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage settings"
  on public.teller_industry_settings for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );
