-- Phase 16C: Entity-specific books — COA, journals, periods, bank, documents, payments.
-- Manual apply only. Metadata backfill to default legal entity; zero economic mutations.
-- Does NOT implement intercompany, consolidation, or eliminations.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.teller_default_legal_entity_id(p_org_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select le.id
  from public.teller_legal_entities le
  where le.organization_id = p_org_id
    and le.is_default = true
    and le.is_active = true
  order by le.created_at asc, le.id asc
  limit 1;
$$;

create or replace function public.teller_assert_entity_belongs_to_org(
  p_org_id uuid,
  p_entity_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_entity_id is null then
    raise exception 'legal_entity_id is required';
  end if;
  if not exists (
    select 1
    from public.teller_legal_entities le
    where le.id = p_entity_id
      and le.organization_id = p_org_id
      and le.is_active = true
  ) then
    raise exception 'Legal entity does not belong to organization';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Entity accounting settings (fiscal year + default GL references per entity)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_entity_accounting_settings (
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  legal_entity_id uuid not null references public.teller_legal_entities (id) on delete cascade,
  fiscal_year_start_month smallint not null default 1
    check (fiscal_year_start_month between 1 and 12),
  accounting_method text not null default 'accrual'
    check (accounting_method in ('accrual', 'cash')),
  default_cash_account_id uuid references public.teller_accounts (id) on delete set null,
  default_ar_account_id uuid references public.teller_accounts (id) on delete set null,
  default_ap_account_id uuid references public.teller_accounts (id) on delete set null,
  retained_earnings_account_id uuid references public.teller_accounts (id) on delete set null,
  customer_deposits_account_id uuid references public.teller_accounts (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, legal_entity_id)
);

create index if not exists teller_entity_accounting_settings_entity_idx
  on public.teller_entity_accounting_settings (legal_entity_id);

alter table public.teller_entity_accounting_settings enable row level security;

create policy "teller members read entity accounting settings"
  on public.teller_entity_accounting_settings for select
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_access_legal_entity(organization_id, legal_entity_id)
  );

create policy "teller admins manage entity accounting settings"
  on public.teller_entity_accounting_settings for all
  using (
    public.teller_is_org_member(organization_id)
    and exists (
      select 1 from public.teller_profiles p
      where p.id = auth.uid()
        and p.organization_id = organization_id
        and p.role in ('owner', 'admin')
    )
  )
  with check (
    public.teller_is_org_member(organization_id)
    and exists (
      select 1 from public.teller_profiles p
      where p.id = auth.uid()
        and p.organization_id = organization_id
        and p.role in ('owner', 'admin')
    )
  );

-- ---------------------------------------------------------------------------
-- Chart of accounts → legal entity ownership
-- ---------------------------------------------------------------------------

alter table public.teller_accounts
  add column if not exists legal_entity_id uuid
    references public.teller_legal_entities (id) on delete restrict;

update public.teller_accounts a
set legal_entity_id = public.teller_default_legal_entity_id(a.organization_id)
where a.legal_entity_id is null
  and public.teller_default_legal_entity_id(a.organization_id) is not null;

alter table public.teller_accounts
  drop constraint if exists teller_accounts_organization_id_code_key;

create unique index if not exists teller_accounts_entity_code_uidx
  on public.teller_accounts (legal_entity_id, code);

create index if not exists teller_accounts_org_entity_idx
  on public.teller_accounts (organization_id, legal_entity_id, code);

alter table public.teller_accounts
  alter column legal_entity_id set not null;

-- ---------------------------------------------------------------------------
-- Journal headers → legal entity ownership
-- ---------------------------------------------------------------------------

alter table public.teller_journal_entries
  add column if not exists legal_entity_id uuid
    references public.teller_legal_entities (id) on delete restrict;

update public.teller_journal_entries j
set legal_entity_id = public.teller_default_legal_entity_id(j.organization_id)
where j.legal_entity_id is null
  and public.teller_default_legal_entity_id(j.organization_id) is not null;

create index if not exists teller_journal_entries_org_entity_date_idx
  on public.teller_journal_entries (organization_id, legal_entity_id, entry_date desc);

alter table public.teller_journal_entries
  alter column legal_entity_id set not null;

-- Posted journal entity immutability
create or replace function public.teller_journal_entries_entity_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'UPDATE' and OLD.legal_entity_id is distinct from NEW.legal_entity_id then
    raise exception 'Posted journal legal entity cannot be reassigned';
  end if;
  return NEW;
end;
$$;

drop trigger if exists teller_journal_entries_entity_immutable on public.teller_journal_entries;
create trigger teller_journal_entries_entity_immutable
  before update of legal_entity_id on public.teller_journal_entries
  for each row execute function public.teller_journal_entries_entity_immutable();

-- ---------------------------------------------------------------------------
-- Documents & payments → legal entity ownership
-- ---------------------------------------------------------------------------

alter table public.teller_documents
  add column if not exists legal_entity_id uuid
    references public.teller_legal_entities (id) on delete restrict;

update public.teller_documents d
set legal_entity_id = public.teller_default_legal_entity_id(d.organization_id)
where d.legal_entity_id is null
  and public.teller_default_legal_entity_id(d.organization_id) is not null;

alter table public.teller_documents
  drop constraint if exists teller_documents_organization_id_kind_number_key;

create unique index if not exists teller_documents_entity_kind_number_uidx
  on public.teller_documents (legal_entity_id, kind, number);

create index if not exists teller_documents_org_entity_idx
  on public.teller_documents (organization_id, legal_entity_id, issue_date desc);

alter table public.teller_documents
  alter column legal_entity_id set not null;

alter table public.teller_payments
  add column if not exists legal_entity_id uuid
    references public.teller_legal_entities (id) on delete restrict;

update public.teller_payments p
set legal_entity_id = public.teller_default_legal_entity_id(p.organization_id)
where p.legal_entity_id is null
  and public.teller_default_legal_entity_id(p.organization_id) is not null;

create index if not exists teller_payments_org_entity_idx
  on public.teller_payments (organization_id, legal_entity_id, payment_date desc);

alter table public.teller_payments
  alter column legal_entity_id set not null;

-- ---------------------------------------------------------------------------
-- Bank accounts → legal entity ownership (connections remain org-scoped)
-- ---------------------------------------------------------------------------

alter table public.teller_bank_accounts
  add column if not exists legal_entity_id uuid
    references public.teller_legal_entities (id) on delete restrict;

update public.teller_bank_accounts b
set legal_entity_id = public.teller_default_legal_entity_id(b.organization_id)
where b.legal_entity_id is null
  and public.teller_default_legal_entity_id(b.organization_id) is not null;

create index if not exists teller_bank_accounts_entity_idx
  on public.teller_bank_accounts (organization_id, legal_entity_id);

alter table public.teller_bank_accounts
  alter column legal_entity_id set not null;

-- ---------------------------------------------------------------------------
-- Accounting periods → legal entity ownership
-- ---------------------------------------------------------------------------

alter table public.teller_period_closes
  add column if not exists legal_entity_id uuid
    references public.teller_legal_entities (id) on delete restrict;

update public.teller_period_closes pc
set legal_entity_id = public.teller_default_legal_entity_id(pc.organization_id)
where pc.legal_entity_id is null
  and public.teller_default_legal_entity_id(pc.organization_id) is not null;

create index if not exists teller_period_closes_org_entity_closed_idx
  on public.teller_period_closes (organization_id, legal_entity_id, closed_at desc);

alter table public.teller_period_closes
  alter column legal_entity_id set not null;

alter table public.teller_period_close_reviews
  add column if not exists legal_entity_id uuid
    references public.teller_legal_entities (id) on delete restrict;

update public.teller_period_close_reviews r
set legal_entity_id = public.teller_default_legal_entity_id(r.organization_id)
where r.legal_entity_id is null;

alter table public.teller_period_close_reviews
  drop constraint if exists teller_period_close_reviews_organization_id_period_end_key;

create unique index if not exists teller_period_close_reviews_entity_period_uidx
  on public.teller_period_close_reviews (legal_entity_id, period_end);

alter table public.teller_period_close_reviews
  alter column legal_entity_id set not null;

alter table public.teller_close_checklist_items
  add column if not exists legal_entity_id uuid
    references public.teller_legal_entities (id) on delete restrict;

update public.teller_close_checklist_items c
set legal_entity_id = public.teller_default_legal_entity_id(c.organization_id)
where c.legal_entity_id is null;

alter table public.teller_close_checklist_items
  drop constraint if exists teller_close_checklist_items_organization_id_period_end_item_key;

create unique index if not exists teller_close_checklist_entity_period_item_uidx
  on public.teller_close_checklist_items (legal_entity_id, period_end, item_key);

alter table public.teller_close_checklist_items
  alter column legal_entity_id set not null;

alter table public.teller_adjusting_journal_entries
  add column if not exists legal_entity_id uuid
    references public.teller_legal_entities (id) on delete restrict;

update public.teller_adjusting_journal_entries a
set legal_entity_id = public.teller_default_legal_entity_id(a.organization_id)
where a.legal_entity_id is null;

alter table public.teller_adjusting_journal_entries
  drop constraint if exists teller_adjusting_journal_entries_organization_id_adjustment_number_key;

create unique index if not exists teller_adjusting_journal_entity_number_uidx
  on public.teller_adjusting_journal_entries (legal_entity_id, adjustment_number);

alter table public.teller_adjusting_journal_entries
  alter column legal_entity_id set not null;

alter table public.teller_recurring_journal_templates
  add column if not exists legal_entity_id uuid
    references public.teller_legal_entities (id) on delete restrict;

update public.teller_recurring_journal_templates t
set legal_entity_id = public.teller_default_legal_entity_id(t.organization_id)
where t.legal_entity_id is null;

alter table public.teller_recurring_journal_templates
  alter column legal_entity_id set not null;

-- Entity-scoped close settings (migrate from org PK)
alter table public.teller_close_settings
  add column if not exists legal_entity_id uuid
    references public.teller_legal_entities (id) on delete cascade;

update public.teller_close_settings cs
set legal_entity_id = public.teller_default_legal_entity_id(cs.organization_id)
where cs.legal_entity_id is null;

alter table public.teller_close_settings
  drop constraint if exists teller_close_settings_pkey;

alter table public.teller_close_settings
  add primary key (organization_id, legal_entity_id);

alter table public.teller_close_settings
  alter column legal_entity_id set not null;

-- Entity-scoped accounting state watermark
alter table public.teller_accounting_state_versions
  add column if not exists legal_entity_id uuid
    references public.teller_legal_entities (id) on delete cascade;

update public.teller_accounting_state_versions v
set legal_entity_id = public.teller_default_legal_entity_id(v.organization_id)
where v.legal_entity_id is null;

alter table public.teller_accounting_state_versions
  drop constraint if exists teller_accounting_state_versions_pkey;

alter table public.teller_accounting_state_versions
  add primary key (organization_id, legal_entity_id);

alter table public.teller_accounting_state_versions
  alter column legal_entity_id set not null;

-- ---------------------------------------------------------------------------
-- Cross-entity integrity guards
-- ---------------------------------------------------------------------------

create or replace function public.teller_assert_accounts_match_entity(
  p_org_id uuid,
  p_entity_id uuid,
  p_lines jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_line jsonb;
  v_account_id uuid;
  v_account_entity uuid;
begin
  perform public.teller_assert_entity_belongs_to_org(p_org_id, p_entity_id);

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Journal lines must be a JSON array';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_account_id := nullif(v_line->>'account_id', '')::uuid;
    if v_account_id is null then
      raise exception 'Journal line requires account_id';
    end if;

    select a.legal_entity_id
    into v_account_entity
    from public.teller_accounts a
    where a.id = v_account_id
      and a.organization_id = p_org_id;

    if v_account_entity is null then
      raise exception 'Account not found for organization';
    end if;
    if v_account_entity <> p_entity_id then
      raise exception 'Cross-entity account posting is not allowed';
    end if;
  end loop;
end;
$$;

create or replace function public.teller_assert_bank_gl_entity_match()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gl_entity uuid;
begin
  if NEW.teller_account_id is null then
    return NEW;
  end if;

  select a.legal_entity_id into v_gl_entity
  from public.teller_accounts a
  where a.id = NEW.teller_account_id
    and a.organization_id = NEW.organization_id;

  if v_gl_entity is null then
    raise exception 'Linked GL account not found';
  end if;
  if v_gl_entity <> NEW.legal_entity_id then
    raise exception 'Bank account GL mapping must belong to the same legal entity';
  end if;

  return NEW;
end;
$$;

drop trigger if exists teller_bank_accounts_gl_entity_guard on public.teller_bank_accounts;
create trigger teller_bank_accounts_gl_entity_guard
  before insert or update of teller_account_id, legal_entity_id
  on public.teller_bank_accounts
  for each row execute function public.teller_assert_bank_gl_entity_match();

-- ---------------------------------------------------------------------------
-- Entity-scoped period close resolution
-- ---------------------------------------------------------------------------

create or replace function public.teller_books_closed_through(
  p_org uuid,
  p_legal_entity_id uuid default null
)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select pc.effective_closed_through
  from public.teller_period_closes pc
  where pc.organization_id = p_org
    and pc.legal_entity_id = coalesce(
      p_legal_entity_id,
      public.teller_default_legal_entity_id(p_org)
    )
  order by pc.closed_at desc, pc.id desc
  limit 1;
$$;

create or replace function public.teller_journal_entries_period_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_closed_through date;
begin
  perform public.teller_acquire_org_accounting_lock(NEW.organization_id);

  v_closed_through := public.teller_books_closed_through(NEW.organization_id, NEW.legal_entity_id);
  if v_closed_through is not null and NEW.entry_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  return NEW;
end;
$$;

-- ---------------------------------------------------------------------------
-- Posting RPC — requires trusted legal_entity_id (server-resolved in app)
-- ---------------------------------------------------------------------------

create or replace function public.teller_post_journal(
  p_organization_id uuid,
  p_legal_entity_id uuid,
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
set search_path = pg_catalog, public
as $$
declare
  v_entry_id uuid;
  v_line jsonb;
  v_debit numeric(14, 2);
  v_credit numeric(14, 2);
  v_total_debit numeric(14, 2) := 0;
  v_total_credit numeric(14, 2) := 0;
  v_closed_through date;
begin
  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to post journal entries';
  end if;

  if auth.uid() is not null
     and not public.teller_can_access_legal_entity(p_organization_id, p_legal_entity_id) then
    raise exception 'Not authorized for this legal entity';
  end if;

  perform public.teller_assert_entity_belongs_to_org(p_organization_id, p_legal_entity_id);
  perform public.teller_assert_accounts_match_entity(p_organization_id, p_legal_entity_id, p_lines);

  perform public.teller_acquire_org_accounting_lock(p_organization_id);

  v_closed_through := public.teller_books_closed_through(p_organization_id, p_legal_entity_id);
  if v_closed_through is not null and p_entry_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
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
    legal_entity_id,
    entry_date,
    memo,
    source_kind,
    source_id,
    reverses_entry_id
  ) values (
    p_organization_id,
    p_legal_entity_id,
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
      job_cost_category_id,
      cost_classification,
      fixed_asset_id,
      memo
    ) values (
      v_entry_id,
      (v_line->>'account_id')::uuid,
      coalesce((v_line->>'debit')::numeric, 0),
      coalesce((v_line->>'credit')::numeric, 0),
      nullif(v_line->>'party_id', '')::uuid,
      nullif(v_line->>'job_id', '')::uuid,
      nullif(v_line->>'job_cost_category_id', '')::uuid,
      coalesce(nullif(v_line->>'cost_classification', ''), ''),
      nullif(v_line->>'fixed_asset_id', '')::uuid,
      coalesce(v_line->>'memo', '')
    );
  end loop;

  return v_entry_id;
end;
$$;

grant execute on function public.teller_post_journal(uuid, uuid, date, text, text, uuid, uuid, jsonb)
  to authenticated, service_role;

grant execute on function public.teller_default_legal_entity_id(uuid)
  to authenticated, service_role;

grant execute on function public.teller_assert_entity_belongs_to_org(uuid, uuid)
  to authenticated, service_role;

grant execute on function public.teller_assert_accounts_match_entity(uuid, uuid, jsonb)
  to authenticated, service_role;

-- Seed entity accounting settings for existing legal entities (structure only; no balances)
insert into public.teller_entity_accounting_settings (organization_id, legal_entity_id)
select le.organization_id, le.id
from public.teller_legal_entities le
where le.is_active = true
on conflict (organization_id, legal_entity_id) do nothing;

-- ---------------------------------------------------------------------------
-- Entity-scoped period close / reopen RPCs
-- ---------------------------------------------------------------------------

create or replace function public.teller_close_accounting_period(
  p_organization_id uuid,
  p_legal_entity_id uuid,
  p_period_end date,
  p_notes text default '',
  p_readiness_snapshot jsonb default '{}'::jsonb,
  p_warnings_acknowledged jsonb default '[]'::jsonb,
  p_actor_id uuid default null,
  p_expected_accounting_version bigint default null,
  p_expected_close_state_version bigint default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_closed date;
  v_expected date;
  v_today date := current_date;
  v_event_id uuid;
  v_acct_ver bigint := 0;
  v_close_ver bigint := 0;
  v_incomplete_required integer;
begin
  if auth.uid() is not null
     and public.teller_user_role(p_organization_id) not in ('owner', 'admin') then
    raise exception 'Not authorized to close accounting periods';
  end if;

  perform public.teller_assert_entity_belongs_to_org(p_organization_id, p_legal_entity_id);
  perform public.teller_acquire_org_accounting_lock(p_organization_id);

  select coalesce(v.accounting_version, 0), coalesce(v.close_state_version, 0)
  into v_acct_ver, v_close_ver
  from public.teller_accounting_state_versions v
  where v.organization_id = p_organization_id
    and v.legal_entity_id = p_legal_entity_id;

  if p_expected_accounting_version is not null and v_acct_ver <> p_expected_accounting_version then
    raise exception 'ACCOUNTING_STATE_CHANGED';
  end if;
  if p_expected_close_state_version is not null and v_close_ver <> p_expected_close_state_version then
    raise exception 'ACCOUNTING_STATE_CHANGED';
  end if;

  if p_period_end > v_today then
    raise exception 'Cannot close a future period';
  end if;

  v_current_closed := public.teller_books_closed_through(p_organization_id, p_legal_entity_id);

  if v_current_closed is not null and p_period_end <= v_current_closed then
    select id into v_event_id
    from public.teller_period_closes
    where organization_id = p_organization_id
      and legal_entity_id = p_legal_entity_id
      and period_end = p_period_end
      and event_type = 'close'
    order by closed_at desc
    limit 1;
    if v_event_id is not null then
      return v_event_id;
    end if;
    raise exception 'That period is already closed';
  end if;

  if v_current_closed is null then
    v_expected := (date_trunc('month', v_today)::date - interval '1 day')::date;
  else
    v_expected := (date_trunc('month', v_current_closed + interval '1 day') + interval '1 month - 1 day')::date;
  end if;

  if p_period_end <> v_expected then
    raise exception 'Close periods in order. Next period to close ends %.', v_expected;
  end if;

  select count(*) into v_incomplete_required
  from public.teller_close_checklist_items
  where organization_id = p_organization_id
    and legal_entity_id = p_legal_entity_id
    and period_end = p_period_end
    and required = true
    and status <> 'completed';

  if v_incomplete_required > 0 then
    raise exception 'Required checklist items incomplete (% remaining)', v_incomplete_required;
  end if;

  insert into public.teller_period_closes (
    organization_id,
    legal_entity_id,
    period_end,
    notes,
    closed_by,
    event_type,
    effective_closed_through,
    readiness_snapshot,
    warnings_acknowledged,
    metadata
  ) values (
    p_organization_id,
    p_legal_entity_id,
    p_period_end,
    coalesce(p_notes, ''),
    coalesce(p_actor_id, auth.uid()),
    'close',
    p_period_end,
    coalesce(p_readiness_snapshot, '{}'::jsonb),
    coalesce(p_warnings_acknowledged, '[]'::jsonb),
    jsonb_build_object(
      'closedAt', now(),
      'accountingVersion', v_acct_ver,
      'closeStateVersion', v_close_ver
    )
  )
  returning id into v_event_id;

  update public.teller_period_close_reviews
  set status = 'closed', updated_at = now()
  where organization_id = p_organization_id
    and legal_entity_id = p_legal_entity_id
    and period_end = p_period_end;

  return v_event_id;
end;
$$;

create or replace function public.teller_reopen_accounting_period(
  p_organization_id uuid,
  p_legal_entity_id uuid,
  p_period_end date,
  p_reason text,
  p_actor_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_closed date;
  v_new_effective date;
  v_event_id uuid;
begin
  if auth.uid() is not null
     and public.teller_user_role(p_organization_id) not in ('owner', 'admin') then
    raise exception 'Not authorized to reopen accounting periods';
  end if;

  perform public.teller_assert_entity_belongs_to_org(p_organization_id, p_legal_entity_id);

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Reopen reason is required';
  end if;

  perform public.teller_acquire_org_accounting_lock(p_organization_id);

  v_current_closed := public.teller_books_closed_through(p_organization_id, p_legal_entity_id);
  if v_current_closed is null or p_period_end <> v_current_closed then
    raise exception 'Only the most recent closed period can be reopened';
  end if;

  v_new_effective := (date_trunc('month', p_period_end)::date - interval '1 day')::date;

  insert into public.teller_period_closes (
    organization_id,
    legal_entity_id,
    period_end,
    notes,
    closed_by,
    event_type,
    effective_closed_through,
    reopen_reason,
    metadata
  ) values (
    p_organization_id,
    p_legal_entity_id,
    p_period_end,
    '',
    coalesce(p_actor_id, auth.uid()),
    'reopen',
    v_new_effective,
    trim(p_reason),
    jsonb_build_object('reopenedAt', now())
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

grant execute on function public.teller_close_accounting_period(uuid, uuid, date, text, jsonb, jsonb, uuid, bigint, bigint)
  to authenticated, service_role;
grant execute on function public.teller_reopen_accounting_period(uuid, uuid, date, text, uuid)
  to authenticated, service_role;
