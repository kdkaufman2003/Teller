-- Phase 10: accounting period close, export audit support, posting lock

-- ---------------------------------------------------------------------------
-- Period close history (append-only closes; reopen removes latest row)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_period_closes (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  period_end date not null,
  notes text not null default '',
  closed_at timestamptz not null default now(),
  closed_by uuid references auth.users (id) on delete set null,
  unique (organization_id, period_end)
);

create index if not exists teller_period_closes_org_idx
  on public.teller_period_closes (organization_id, period_end desc);

alter table public.teller_period_closes enable row level security;

create policy "teller members read period closes"
  on public.teller_period_closes for select
  using (public.teller_is_org_member(organization_id));

create policy "teller admins insert period closes"
  on public.teller_period_closes for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_user_role(organization_id) in ('owner', 'admin')
  );

create policy "teller admins delete period closes"
  on public.teller_period_closes for delete
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_user_role(organization_id) in ('owner', 'admin')
  );

-- ---------------------------------------------------------------------------
-- Closed-through helper
-- ---------------------------------------------------------------------------

create or replace function public.teller_books_closed_through(p_org uuid)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select max(period_end)
  from public.teller_period_closes
  where organization_id = p_org;
$$;

-- ---------------------------------------------------------------------------
-- Block journal posting into closed periods
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
  v_closed_through date;
begin
  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to post journal entries';
  end if;

  v_closed_through := public.teller_books_closed_through(p_organization_id);
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

grant execute on function public.teller_books_closed_through(uuid) to authenticated, service_role;
