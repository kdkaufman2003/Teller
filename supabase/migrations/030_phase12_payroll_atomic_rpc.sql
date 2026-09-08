-- Phase 12: Atomic payroll posting RPCs (claim-before-post, no orphan journals)
-- RPC-only — does NOT alter teller_post_journal signature or Phase 12 tables.
-- Manual apply only after Phase 12 acceptance authorization.

-- ---------------------------------------------------------------------------
-- Atomic payroll run posting — row lock before journal creation
-- ---------------------------------------------------------------------------

create or replace function public.teller_atomic_post_payroll_run(
  p_organization_id uuid,
  p_payroll_run_id uuid,
  p_entry_date date,
  p_memo text,
  p_lines jsonb,
  p_actor_id uuid default null,
  p_simulate_failure_after text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_run public.teller_payroll_runs%rowtype;
  v_journal_id uuid;
  v_existing_journal uuid;
  v_closed_through date;
begin
  if auth.uid() is not null and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to post payroll run';
  end if;

  perform public.teller_acquire_org_accounting_lock(p_organization_id);

  v_closed_through := public.teller_books_closed_through(p_organization_id);
  if v_closed_through is not null and p_entry_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  select * into v_run
  from public.teller_payroll_runs
  where id = p_payroll_run_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Payroll run not found in organization';
  end if;

  if v_run.journal_entry_id is not null then
    return jsonb_build_object(
      'duplicate', true,
      'payroll_run_id', v_run.id,
      'journal_entry_id', v_run.journal_entry_id
    );
  end if;

  select je.id into v_existing_journal
  from public.teller_journal_entries je
  where je.organization_id = p_organization_id
    and je.source_kind = 'payroll_run'
    and je.source_id = p_payroll_run_id
  order by je.created_at asc
  limit 1;

  if v_existing_journal is not null then
    update public.teller_payroll_runs
    set
      journal_entry_id = v_existing_journal,
      status = 'posted',
      posted_at = coalesce(posted_at, now()),
      posted_by = coalesce(posted_by, p_actor_id),
      updated_at = now()
    where id = p_payroll_run_id;

    return jsonb_build_object(
      'duplicate', true,
      'recovered', true,
      'payroll_run_id', p_payroll_run_id,
      'journal_entry_id', v_existing_journal
    );
  end if;

  if p_simulate_failure_after = 'before_journal' then
    raise exception 'Simulated failure before payroll journal creation';
  end if;

  v_journal_id := public.teller_post_journal(
    p_organization_id,
    p_entry_date,
    coalesce(p_memo, ''),
    'payroll_run',
    p_payroll_run_id,
    null,
    p_lines
  );

  if p_simulate_failure_after = 'after_journal' then
    raise exception 'Simulated failure after payroll journal creation';
  end if;

  update public.teller_payroll_runs
  set
    journal_entry_id = v_journal_id,
    status = 'posted',
    posted_at = now(),
    posted_by = p_actor_id,
    updated_at = now()
  where id = p_payroll_run_id;

  return jsonb_build_object(
    'duplicate', false,
    'payroll_run_id', p_payroll_run_id,
    'journal_entry_id', v_journal_id
  );
end;
$$;

grant execute on function public.teller_atomic_post_payroll_run(uuid, uuid, date, text, jsonb, uuid, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Atomic payroll run reversal — row lock before reversal journal
-- ---------------------------------------------------------------------------

create or replace function public.teller_atomic_reverse_payroll_run(
  p_organization_id uuid,
  p_payroll_run_id uuid,
  p_reversal_date date,
  p_memo text,
  p_lines jsonb,
  p_actor_id uuid default null,
  p_simulate_failure_after text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_run public.teller_payroll_runs%rowtype;
  v_reversal_id uuid;
  v_existing_reversal uuid;
  v_closed_through date;
begin
  if auth.uid() is not null and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to reverse payroll run';
  end if;

  perform public.teller_acquire_org_accounting_lock(p_organization_id);

  v_closed_through := public.teller_books_closed_through(p_organization_id);
  if v_closed_through is not null and p_reversal_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  select * into v_run
  from public.teller_payroll_runs
  where id = p_payroll_run_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Payroll run not found in organization';
  end if;

  if v_run.reversal_journal_entry_id is not null or v_run.status = 'reversed' then
    return jsonb_build_object(
      'duplicate', true,
      'payroll_run_id', v_run.id,
      'reversal_journal_entry_id', v_run.reversal_journal_entry_id
    );
  end if;

  if v_run.journal_entry_id is null or v_run.status <> 'posted' then
    raise exception 'Only posted payroll runs can be reversed';
  end if;

  select je.id into v_existing_reversal
  from public.teller_journal_entries je
  where je.organization_id = p_organization_id
    and je.source_kind = 'reversal'
    and je.reverses_entry_id = v_run.journal_entry_id
  order by je.created_at asc
  limit 1;

  if v_existing_reversal is not null then
    update public.teller_payroll_runs
    set
      reversal_journal_entry_id = v_existing_reversal,
      status = 'reversed',
      reversed_at = coalesce(reversed_at, now()),
      reversed_by = coalesce(reversed_by, p_actor_id),
      updated_at = now()
    where id = p_payroll_run_id;

    return jsonb_build_object(
      'duplicate', true,
      'recovered', true,
      'payroll_run_id', p_payroll_run_id,
      'reversal_journal_entry_id', v_existing_reversal
    );
  end if;

  if p_simulate_failure_after = 'before_journal' then
    raise exception 'Simulated failure before payroll reversal journal creation';
  end if;

  v_reversal_id := public.teller_post_journal(
    p_organization_id,
    p_reversal_date,
    coalesce(p_memo, ''),
    'reversal',
    p_payroll_run_id,
    v_run.journal_entry_id,
    p_lines
  );

  if p_simulate_failure_after = 'after_journal' then
    raise exception 'Simulated failure after payroll reversal journal creation';
  end if;

  update public.teller_payroll_runs
  set
    reversal_journal_entry_id = v_reversal_id,
    status = 'reversed',
    reversed_at = now(),
    reversed_by = p_actor_id,
    updated_at = now()
  where id = p_payroll_run_id;

  return jsonb_build_object(
    'duplicate', false,
    'payroll_run_id', p_payroll_run_id,
    'reversal_journal_entry_id', v_reversal_id
  );
end;
$$;

grant execute on function public.teller_atomic_reverse_payroll_run(uuid, uuid, date, text, jsonb, uuid, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Atomic payroll settlement posting — row lock before settlement journal
-- ---------------------------------------------------------------------------

create or replace function public.teller_atomic_post_payroll_settlement(
  p_organization_id uuid,
  p_settlement_id uuid,
  p_entry_date date,
  p_memo text,
  p_lines jsonb,
  p_actor_id uuid default null,
  p_simulate_failure_after text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_settlement public.teller_payroll_liability_settlements%rowtype;
  v_journal_id uuid;
  v_existing_journal uuid;
  v_closed_through date;
begin
  if auth.uid() is not null and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to post payroll settlement';
  end if;

  perform public.teller_acquire_org_accounting_lock(p_organization_id);

  v_closed_through := public.teller_books_closed_through(p_organization_id);
  if v_closed_through is not null and p_entry_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  select * into v_settlement
  from public.teller_payroll_liability_settlements
  where id = p_settlement_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Payroll settlement not found in organization';
  end if;

  if v_settlement.journal_entry_id is not null then
    return jsonb_build_object(
      'duplicate', true,
      'settlement_id', v_settlement.id,
      'journal_entry_id', v_settlement.journal_entry_id
    );
  end if;

  select je.id into v_existing_journal
  from public.teller_journal_entries je
  where je.organization_id = p_organization_id
    and je.source_kind = 'payroll_settlement'
    and je.source_id = p_settlement_id
  order by je.created_at asc
  limit 1;

  if v_existing_journal is not null then
    update public.teller_payroll_liability_settlements
    set journal_entry_id = v_existing_journal
    where id = p_settlement_id;

    return jsonb_build_object(
      'duplicate', true,
      'recovered', true,
      'settlement_id', p_settlement_id,
      'journal_entry_id', v_existing_journal
    );
  end if;

  if p_simulate_failure_after = 'before_journal' then
    raise exception 'Simulated failure before payroll settlement journal creation';
  end if;

  v_journal_id := public.teller_post_journal(
    p_organization_id,
    p_entry_date,
    coalesce(p_memo, ''),
    'payroll_settlement',
    p_settlement_id,
    null,
    p_lines
  );

  if p_simulate_failure_after = 'after_journal' then
    raise exception 'Simulated failure after payroll settlement journal creation';
  end if;

  update public.teller_payroll_liability_settlements
  set journal_entry_id = v_journal_id
  where id = p_settlement_id;

  return jsonb_build_object(
    'duplicate', false,
    'settlement_id', p_settlement_id,
    'journal_entry_id', v_journal_id
  );
end;
$$;

grant execute on function public.teller_atomic_post_payroll_settlement(uuid, uuid, date, text, jsonb, uuid, text)
  to authenticated, service_role;

notify pgrst, 'reload schema';
