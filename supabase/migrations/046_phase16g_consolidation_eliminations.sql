-- Phase 16G: Consolidation elimination layer (reporting-only adjustments).
-- Manual apply only. Does NOT post to legal-entity journals or mutate entity books.
-- Eliminations are organization-scoped consolidation records with balanced lines.

-- ---------------------------------------------------------------------------
-- Consolidation elimination entries
-- ---------------------------------------------------------------------------

create table if not exists public.teller_consolidation_elimination_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  scope_key text not null,
  legal_entity_ids uuid[] not null,
  effective_date date not null,
  period_start date,
  period_end date,
  entry_type text not null
    check (entry_type in (
      'due_to_due_from',
      'intercompany_pl',
      'manual',
      'cash_flow_reclass'
    )),
  source_kind text not null default 'manual'
    check (source_kind in ('suggested', 'manual', 'system')),
  status text not null default 'draft'
    check (status in ('draft', 'suggested', 'approved', 'posted', 'reversed')),
  description text not null default '',
  memo text not null default '',
  currency text not null default 'USD',
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  approved_by uuid references auth.users (id) on delete set null,
  posted_by uuid references auth.users (id) on delete set null,
  reversed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  posted_at timestamptz,
  reversed_at timestamptz,
  reverses_entry_id uuid references public.teller_consolidation_elimination_entries (id) on delete restrict,
  reversal_entry_id uuid references public.teller_consolidation_elimination_entries (id) on delete restrict,
  constraint teller_consolidation_elimination_scope_nonempty check (
    cardinality(legal_entity_ids) >= 1
  ),
  constraint teller_consolidation_elimination_reversal_pair check (
    reverses_entry_id is null or reversal_entry_id is null
  )
);

create unique index if not exists teller_consolidation_elimination_idempotency_uidx
  on public.teller_consolidation_elimination_entries (organization_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists teller_consolidation_elimination_org_scope_idx
  on public.teller_consolidation_elimination_entries (organization_id, scope_key, effective_date desc);

create index if not exists teller_consolidation_elimination_org_status_idx
  on public.teller_consolidation_elimination_entries (organization_id, status);

-- ---------------------------------------------------------------------------
-- Consolidation elimination lines (balanced consolidation adjustments)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_consolidation_elimination_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  entry_id uuid not null references public.teller_consolidation_elimination_entries (id) on delete restrict,
  line_number int not null check (line_number > 0),
  group_key text not null,
  account_type text not null,
  account_subtype text not null default '',
  account_code text not null,
  account_name text not null,
  source_legal_entity_id uuid references public.teller_legal_entities (id) on delete restrict,
  source_account_id uuid references public.teller_accounts (id) on delete restrict,
  debit numeric(14, 2) not null default 0 check (debit >= 0),
  credit numeric(14, 2) not null default 0 check (credit >= 0),
  memo text not null default '',
  constraint teller_consolidation_elimination_line_side check (
    (debit > 0 and credit = 0) or (credit > 0 and debit = 0)
  ),
  constraint teller_consolidation_elimination_line_nontrivial check (
    debit > 0 or credit > 0
  )
);

create unique index if not exists teller_consolidation_elimination_line_entry_num_uidx
  on public.teller_consolidation_elimination_lines (entry_id, line_number);

create index if not exists teller_consolidation_elimination_line_entry_idx
  on public.teller_consolidation_elimination_lines (entry_id);

create index if not exists teller_consolidation_elimination_line_group_idx
  on public.teller_consolidation_elimination_lines (organization_id, group_key);

-- ---------------------------------------------------------------------------
-- Source traceability links
-- ---------------------------------------------------------------------------

create table if not exists public.teller_consolidation_elimination_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  entry_id uuid not null references public.teller_consolidation_elimination_entries (id) on delete restrict,
  source_kind text not null
    check (source_kind in (
      'intercompany_pair',
      'intercompany_transaction',
      'reconciliation',
      'journal_entry',
      'manual'
    )),
  source_id uuid,
  source_reference text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists teller_consolidation_elimination_source_entry_idx
  on public.teller_consolidation_elimination_sources (entry_id);

-- ---------------------------------------------------------------------------
-- Optional consolidation report lock (lightweight)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_consolidation_report_locks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  scope_key text not null,
  period_end date not null,
  locked_at timestamptz not null default now(),
  locked_by uuid references auth.users (id) on delete set null,
  notes text not null default '',
  constraint teller_consolidation_report_lock_scope_uidx unique (
    organization_id,
    scope_key,
    period_end
  )
);

-- ---------------------------------------------------------------------------
-- Immutability — posted eliminations cannot be edited; corrections via reversal
-- ---------------------------------------------------------------------------

create or replace function public.teller_consolidation_elimination_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if old.status in ('posted', 'reversed') then
      if new.organization_id is distinct from old.organization_id
         or new.scope_key is distinct from old.scope_key
         or new.legal_entity_ids is distinct from old.legal_entity_ids
         or new.effective_date is distinct from old.effective_date
         or new.period_start is distinct from old.period_start
         or new.period_end is distinct from old.period_end
         or new.entry_type is distinct from old.entry_type
         or new.source_kind is distinct from old.source_kind
         or new.description is distinct from old.description
         or new.memo is distinct from old.memo
         or new.idempotency_key is distinct from old.idempotency_key
         or new.metadata is distinct from old.metadata then
        raise exception 'Posted consolidation elimination cannot be modified';
      end if;
      if new.status = 'reversed'
         and old.status = 'posted'
         and new.reversal_entry_id is not null then
        return new;
      end if;
      if old.status = 'posted'
         and new.status is distinct from old.status
         and new.status <> 'reversed' then
        raise exception 'Posted consolidation elimination cannot be modified';
      end if;
    end if;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Consolidation eliminations cannot be deleted';
  end if;
  return new;
end;
$$;

drop trigger if exists teller_consolidation_elimination_immutable_trg
  on public.teller_consolidation_elimination_entries;

create trigger teller_consolidation_elimination_immutable_trg
  before update or delete on public.teller_consolidation_elimination_entries
  for each row execute function public.teller_consolidation_elimination_immutable();

create or replace function public.teller_consolidation_elimination_lines_immutable()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  if tg_op = 'DELETE' then
    raise exception 'Consolidation elimination lines cannot be deleted';
  end if;
  select status into v_status
  from public.teller_consolidation_elimination_entries
  where id = coalesce(new.entry_id, old.entry_id);
  if v_status in ('posted', 'reversed') then
    raise exception 'Posted consolidation elimination lines cannot be modified';
  end if;
  return new;
end;
$$;

drop trigger if exists teller_consolidation_elimination_lines_immutable_trg
  on public.teller_consolidation_elimination_lines;

create trigger teller_consolidation_elimination_lines_immutable_trg
  before update or delete on public.teller_consolidation_elimination_lines
  for each row execute function public.teller_consolidation_elimination_lines_immutable();

-- ---------------------------------------------------------------------------
-- Scope helpers
-- ---------------------------------------------------------------------------

create or replace function public.teller_consolidation_scope_key(
  p_organization_id uuid,
  p_legal_entity_ids uuid[]
)
returns text
language sql
immutable
as $$
  select p_organization_id::text || ':' || array_to_string(
    (select array_agg(id order by id) from unnest(p_legal_entity_ids) as id),
    ','
  );
$$;

create or replace function public.teller_consolidation_scope_entities_accessible(
  p_organization_id uuid,
  p_legal_entity_ids uuid[]
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entity uuid;
begin
  if auth.uid() is null then
    return true;
  end if;
  if not public.teller_is_org_member(p_organization_id) then
    return false;
  end if;
  if exists (
    select 1
    from public.teller_profiles p
    where p.id = auth.uid()
      and p.organization_id = p_organization_id
      and p.role in ('owner', 'admin')
  ) then
    return true;
  end if;
  if not public.teller_has_restricted_entity_access(p_organization_id) then
    return true;
  end if;
  foreach v_entity in array p_legal_entity_ids loop
    if not public.teller_can_access_legal_entity(p_organization_id, v_entity) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Atomic post — balanced lines required; no legal-entity journal writes
-- ---------------------------------------------------------------------------

create or replace function public.teller_atomic_post_consolidation_elimination(
  p_entry_id uuid,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.teller_consolidation_elimination_entries%rowtype;
  v_debit numeric(14, 2) := 0;
  v_credit numeric(14, 2) := 0;
  v_line_count int := 0;
begin
  select * into v_entry
  from public.teller_consolidation_elimination_entries
  where id = p_entry_id
  for update;

  if not found then
    raise exception 'Consolidation elimination entry not found';
  end if;

  if auth.uid() is not null then
    if not public.teller_is_org_member(v_entry.organization_id) then
      raise exception 'Not authorized';
    end if;
    if not public.teller_can_write_books(v_entry.organization_id) then
      raise exception 'Not authorized to post consolidation eliminations';
    end if;
    if not public.teller_consolidation_scope_entities_accessible(
      v_entry.organization_id,
      v_entry.legal_entity_ids
    ) then
      raise exception 'Not authorized for all entities in consolidation scope';
    end if;
  end if;

  if v_entry.status not in ('draft', 'suggested', 'approved') then
    raise exception 'Only draft, suggested, or approved eliminations can be posted';
  end if;

  select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
  into v_debit, v_credit, v_line_count
  from public.teller_consolidation_elimination_lines
  where entry_id = v_entry.id;

  if v_line_count < 2 then
    raise exception 'Consolidation elimination requires at least two lines';
  end if;

  if abs(v_debit - v_credit) > 0.009 then
    raise exception 'Consolidation elimination entry is not balanced';
  end if;

  update public.teller_consolidation_elimination_entries
  set status = 'posted',
      posted_at = now(),
      posted_by = coalesce(p_actor_id, auth.uid()),
      approved_at = coalesce(approved_at, now()),
      approved_by = coalesce(approved_by, coalesce(p_actor_id, auth.uid()))
  where id = v_entry.id;

  return jsonb_build_object(
    'entry_id', v_entry.id,
    'status', 'posted',
    'total_debit', v_debit,
    'total_credit', v_credit
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Atomic reverse — creates linked reversal entry; original marked reversed
-- ---------------------------------------------------------------------------

create or replace function public.teller_atomic_reverse_consolidation_elimination(
  p_entry_id uuid,
  p_actor_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.teller_consolidation_elimination_entries%rowtype;
  v_existing public.teller_consolidation_elimination_entries%rowtype;
  v_reversal_id uuid;
  v_line record;
  v_line_num int := 0;
begin
  if p_idempotency_key is not null then
    select * into v_existing
    from public.teller_consolidation_elimination_entries
    where organization_id = (
      select organization_id from public.teller_consolidation_elimination_entries where id = p_entry_id
    )
      and idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object(
        'entry_id', v_existing.id,
        'reversal_of', v_existing.reverses_entry_id,
        'status', v_existing.status,
        'duplicate', true
      );
    end if;
  end if;

  select * into v_entry
  from public.teller_consolidation_elimination_entries
  where id = p_entry_id
  for update;

  if not found then
    raise exception 'Consolidation elimination entry not found';
  end if;

  if v_entry.status <> 'posted' then
    raise exception 'Only posted consolidation eliminations can be reversed';
  end if;

  if auth.uid() is not null then
    if not public.teller_is_org_member(v_entry.organization_id) then
      raise exception 'Not authorized';
    end if;
    if not public.teller_can_write_books(v_entry.organization_id) then
      raise exception 'Not authorized to reverse consolidation eliminations';
    end if;
  end if;

  insert into public.teller_consolidation_elimination_entries (
    organization_id,
    scope_key,
    legal_entity_ids,
    effective_date,
    period_start,
    period_end,
    entry_type,
    source_kind,
    status,
    description,
    memo,
    currency,
    idempotency_key,
    metadata,
    created_by,
    posted_by,
    posted_at,
    reverses_entry_id
  ) values (
    v_entry.organization_id,
    v_entry.scope_key,
    v_entry.legal_entity_ids,
    v_entry.effective_date,
    v_entry.period_start,
    v_entry.period_end,
    v_entry.entry_type,
    'system',
    'posted',
    'Reversal of ' || v_entry.description,
    coalesce(v_entry.memo, '') || ' [reversal]',
    v_entry.currency,
    p_idempotency_key,
    jsonb_build_object('reversal_of', v_entry.id),
    coalesce(p_actor_id, auth.uid()),
    coalesce(p_actor_id, auth.uid()),
    now(),
    v_entry.id
  )
  returning id into v_reversal_id;

  for v_line in
    select *
    from public.teller_consolidation_elimination_lines
    where entry_id = v_entry.id
    order by line_number
  loop
    v_line_num := v_line_num + 1;
    insert into public.teller_consolidation_elimination_lines (
      organization_id,
      entry_id,
      line_number,
      group_key,
      account_type,
      account_subtype,
      account_code,
      account_name,
      source_legal_entity_id,
      source_account_id,
      debit,
      credit,
      memo
    ) values (
      v_line.organization_id,
      v_reversal_id,
      v_line_num,
      v_line.group_key,
      v_line.account_type,
      v_line.account_subtype,
      v_line.account_code,
      v_line.account_name,
      v_line.source_legal_entity_id,
      v_line.source_account_id,
      v_line.credit,
      v_line.debit,
      'Reversal: ' || v_line.memo
    );
  end loop;

  update public.teller_consolidation_elimination_entries
  set status = 'reversed',
      reversed_at = now(),
      reversed_by = coalesce(p_actor_id, auth.uid()),
      reversal_entry_id = v_reversal_id
  where id = v_entry.id;

  return jsonb_build_object(
    'entry_id', v_reversal_id,
    'reversal_of', v_entry.id,
    'status', 'posted'
  );
end;
$$;

grant execute on function public.teller_consolidation_scope_key(uuid, uuid[]) to authenticated, service_role;
grant execute on function public.teller_consolidation_scope_entities_accessible(uuid, uuid[]) to authenticated, service_role;
grant execute on function public.teller_atomic_post_consolidation_elimination(uuid, uuid) to authenticated, service_role;
grant execute on function public.teller_atomic_reverse_consolidation_elimination(uuid, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS — org member + all scope entities accessible; writes via RPC only
-- ---------------------------------------------------------------------------

alter table public.teller_consolidation_elimination_entries enable row level security;
alter table public.teller_consolidation_elimination_lines enable row level security;
alter table public.teller_consolidation_elimination_sources enable row level security;
alter table public.teller_consolidation_report_locks enable row level security;

drop policy if exists "teller consolidation elimination entries select" on public.teller_consolidation_elimination_entries;
create policy "teller consolidation elimination entries select"
  on public.teller_consolidation_elimination_entries for select
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_consolidation_scope_entities_accessible(organization_id, legal_entity_ids)
  );

drop policy if exists "teller consolidation elimination lines select" on public.teller_consolidation_elimination_lines;
create policy "teller consolidation elimination lines select"
  on public.teller_consolidation_elimination_lines for select
  using (
    public.teller_is_org_member(organization_id)
    and exists (
      select 1
      from public.teller_consolidation_elimination_entries e
      where e.id = entry_id
        and public.teller_consolidation_scope_entities_accessible(e.organization_id, e.legal_entity_ids)
    )
  );

drop policy if exists "teller consolidation elimination sources select" on public.teller_consolidation_elimination_sources;
create policy "teller consolidation elimination sources select"
  on public.teller_consolidation_elimination_sources for select
  using (
    public.teller_is_org_member(organization_id)
    and exists (
      select 1
      from public.teller_consolidation_elimination_entries e
      where e.id = entry_id
        and public.teller_consolidation_scope_entities_accessible(e.organization_id, e.legal_entity_ids)
    )
  );

drop policy if exists "teller consolidation report locks select" on public.teller_consolidation_report_locks;
create policy "teller consolidation report locks select"
  on public.teller_consolidation_report_locks for select
  using (public.teller_is_org_member(organization_id));

-- Draft/approved writes for accountants; posted entries mutate only via RPC.
drop policy if exists "teller consolidation elimination entries insert" on public.teller_consolidation_elimination_entries;
create policy "teller consolidation elimination entries insert"
  on public.teller_consolidation_elimination_entries for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
    and public.teller_consolidation_scope_entities_accessible(organization_id, legal_entity_ids)
    and status in ('draft', 'suggested', 'approved')
  );

drop policy if exists "teller consolidation elimination entries update draft" on public.teller_consolidation_elimination_entries;
create policy "teller consolidation elimination entries update draft"
  on public.teller_consolidation_elimination_entries for update
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
    and status in ('draft', 'suggested', 'approved')
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
    and status in ('draft', 'suggested', 'approved')
  );

drop policy if exists "teller consolidation elimination lines insert" on public.teller_consolidation_elimination_lines;
create policy "teller consolidation elimination lines insert"
  on public.teller_consolidation_elimination_lines for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
    and exists (
      select 1
      from public.teller_consolidation_elimination_entries e
      where e.id = entry_id
        and e.status in ('draft', 'suggested', 'approved')
        and public.teller_consolidation_scope_entities_accessible(e.organization_id, e.legal_entity_ids)
    )
  );

drop policy if exists "teller consolidation elimination sources insert" on public.teller_consolidation_elimination_sources;
create policy "teller consolidation elimination sources insert"
  on public.teller_consolidation_elimination_sources for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
    and exists (
      select 1
      from public.teller_consolidation_elimination_entries e
      where e.id = entry_id
        and e.status in ('draft', 'suggested', 'approved')
        and public.teller_consolidation_scope_entities_accessible(e.organization_id, e.legal_entity_ids)
    )
  );
