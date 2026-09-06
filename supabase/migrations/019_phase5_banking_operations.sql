-- Phase 5B: Banking operations — import, match, exclude (no journal posting)
-- Builds on 018 schema; ingest and match workflows only.

-- ---------------------------------------------------------------------------
-- Schema: CSV import dedupe
-- ---------------------------------------------------------------------------

alter table public.teller_bank_transactions
  add column if not exists import_fingerprint text,
  add column if not exists csv_import_batch_id uuid
    references public.teller_bank_import_batches (id) on delete set null;

-- Non-unique: fingerprint supports duplicate detection, not hard blocking of legitimate rows.
create index if not exists teller_bank_transactions_import_fingerprint_idx
  on public.teller_bank_transactions (organization_id, bank_account_id, import_fingerprint)
  where import_fingerprint is not null;

create index if not exists teller_bank_transactions_import_batch_idx
  on public.teller_bank_transactions (organization_id, csv_import_batch_id)
  where csv_import_batch_id is not null;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.teller_bank_tx_confirmed_match_total(
  p_bank_transaction_id uuid
)
returns numeric
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(round(sum(m.matched_amount)::numeric, 2), 0)
  from public.teller_bank_matches m
  where m.bank_transaction_id = p_bank_transaction_id
    and m.status = 'confirmed';
$$;

create or replace function public.teller_bank_resource_confirmed_match_total(
  p_organization_id uuid,
  p_resource_type text,
  p_resource_id uuid
)
returns numeric
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(round(sum(m.matched_amount)::numeric, 2), 0)
  from public.teller_bank_matches m
  where m.organization_id = p_organization_id
    and m.matched_resource_type = p_resource_type
    and m.matched_resource_id = p_resource_id
    and m.status = 'confirmed';
$$;

create or replace function public.teller_assert_bank_matchable_resource(
  p_organization_id uuid,
  p_resource_type text,
  p_resource_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  case p_resource_type
    when 'customer_payment' then
      if not exists (
        select 1
        from public.teller_payments p
        where p.id = p_resource_id
          and p.organization_id = p_organization_id
          and p.payment_type = 'customer_payment'
          and coalesce(p.status, 'posted') = 'posted'
      ) then
        raise exception 'Customer payment % is invalid for organization', p_resource_id;
      end if;

    when 'bill_payment' then
      if not exists (
        select 1
        from public.teller_payments p
        where p.id = p_resource_id
          and p.organization_id = p_organization_id
          and p.payment_type = 'bill_payment'
          and coalesce(p.status, 'posted') = 'posted'
      ) then
        raise exception 'Bill payment % is invalid for organization', p_resource_id;
      end if;

    when 'expense_payment' then
      if not exists (
        select 1
        from public.teller_payments p
        left join public.teller_documents d on d.id = p.document_id
        where p.id = p_resource_id
          and p.organization_id = p_organization_id
          and coalesce(p.status, 'posted') = 'posted'
          and (
            p.payment_type = 'bill_payment'
            or d.kind in ('expense', 'bill')
          )
      ) then
        raise exception 'Expense payment % is invalid for organization', p_resource_id;
      end if;

    when 'customer_deposit' then
      if not exists (
        select 1
        from public.teller_payments p
        where p.id = p_resource_id
          and p.organization_id = p_organization_id
          and p.payment_type = 'customer_deposit'
          and coalesce(p.status, 'posted') = 'posted'
      ) then
        raise exception 'Customer deposit % is invalid for organization', p_resource_id;
      end if;

    when 'deposit_refund' then
      if not exists (
        select 1
        from public.teller_payments p
        where p.id = p_resource_id
          and p.organization_id = p_organization_id
          and p.payment_type = 'customer_refund'
          and coalesce(p.status, 'posted') = 'posted'
          and coalesce(p.metadata ->> 'kind', '') = 'deposit_refund'
      ) then
        raise exception 'Deposit refund % is invalid for organization', p_resource_id;
      end if;

    when 'credit_refund' then
      if not exists (
        select 1
        from public.teller_payments p
        where p.id = p_resource_id
          and p.organization_id = p_organization_id
          and p.payment_type = 'customer_refund'
          and coalesce(p.status, 'posted') = 'posted'
      ) then
        raise exception 'Credit refund % is invalid for organization', p_resource_id;
      end if;

    when 'payment_reversal' then
      if not exists (
        select 1
        from public.teller_payments p
        where p.id = p_resource_id
          and p.organization_id = p_organization_id
          and p.reversal_event_id is not null
          and coalesce(p.status, 'posted') = 'void'
      ) then
        raise exception 'Payment reversal % is invalid for organization', p_resource_id;
      end if;

    when 'bank_transfer' then
      if not exists (
        select 1
        from public.teller_bank_transfers t
        where t.id = p_resource_id
          and t.organization_id = p_organization_id
          and t.status = 'confirmed'
      ) then
        raise exception 'Bank transfer % is invalid for organization', p_resource_id;
      end if;

    when 'journal_entry' then
      if not exists (
        select 1
        from public.teller_journal_entries je
        where je.id = p_resource_id
          and je.organization_id = p_organization_id
      ) then
        raise exception 'Journal entry % is invalid for organization', p_resource_id;
      end if;

    when 'document' then
      perform public.teller_assert_org_document(p_organization_id, p_resource_id, null);

    when 'bank_fee', 'interest_income', 'interest_expense', 'owner_contribution', 'owner_draw' then
      if not exists (
        select 1
        from public.teller_journal_entries je
        where je.id = p_resource_id
          and je.organization_id = p_organization_id
      ) then
        raise exception 'Journal entry % is invalid for categorized resource', p_resource_id;
      end if;

    else
      raise exception 'Unsupported bank match resource type: %', p_resource_type;
  end case;
end;
$$;

create or replace function public.teller_recalc_bank_transaction_status(
  p_bank_transaction_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_txn public.teller_bank_transactions%rowtype;
  v_confirmed numeric(14, 2);
  v_target numeric(14, 2);
  v_next_status text;
begin
  select * into v_txn
  from public.teller_bank_transactions
  where id = p_bank_transaction_id
  for update;

  if not found then
    raise exception 'Bank transaction % does not exist', p_bank_transaction_id;
  end if;

  if v_txn.status in ('excluded', 'reconciled', 'categorized') then
    return v_txn.status;
  end if;

  if v_txn.provider_lifecycle_state in ('provider_removed', 'superseded') then
    return v_txn.status;
  end if;

  v_confirmed := public.teller_bank_tx_confirmed_match_total(v_txn.id);
  v_target := round(abs(coalesce(v_txn.normalized_amount, 0))::numeric, 2);

  if v_confirmed <= 0 then
    v_next_status := case
      when v_txn.status = 'suggested' then 'suggested'
      else 'unreviewed'
    end;
  elsif v_confirmed + 0.009 < v_target then
    v_next_status := 'partially_matched';
  else
    v_next_status := 'matched';
  end if;

  if v_txn.status is distinct from v_next_status then
    update public.teller_bank_transactions
    set
      status = v_next_status,
      updated_at = now()
    where id = v_txn.id;
  end if;

  return v_next_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Atomic provider/CSV batch ingest (never posts journals)
-- ---------------------------------------------------------------------------

create or replace function public.teller_import_bank_transactions(
  p_organization_id uuid,
  p_bank_account_id uuid,
  p_provider text,
  p_transactions jsonb,
  p_removed_provider_ids text[],
  p_import_batch_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bank_account public.teller_bank_accounts%rowtype;
  v_item jsonb;
  v_provider_id text;
  v_pending_id text;
  v_fingerprint text;
  v_txn_id uuid;
  v_is_pending boolean;
  v_imported integer := 0;
  v_updated integer := 0;
  v_superseded integer := 0;
  v_removed integer := 0;
  v_duplicate integer := 0;
  v_provider_id_list text[];
  v_was_insert boolean;
begin
  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to import bank transactions';
  end if;

  select * into v_bank_account
  from public.teller_bank_accounts
  where id = p_bank_account_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Bank account not found in organization';
  end if;

  if p_import_batch_id is not null then
    if not exists (
      select 1
      from public.teller_bank_import_batches b
      where b.id = p_import_batch_id
        and b.organization_id = p_organization_id
        and b.bank_account_id = p_bank_account_id
    ) then
      raise exception 'Import batch not found for bank account';
    end if;
  end if;

  if p_transactions is not null and jsonb_typeof(p_transactions) = 'array' then
    for v_item in select value from jsonb_array_elements(p_transactions) loop
      v_provider_id := nullif(trim(coalesce(v_item->>'provider_transaction_id', v_item->>'external_transaction_id', '')), '');
      v_fingerprint := nullif(trim(coalesce(v_item->>'import_fingerprint', '')), '');
      v_is_pending := coalesce((v_item->>'pending')::boolean, false);
      v_pending_id := nullif(trim(coalesce(v_item->>'provider_pending_transaction_id', '')), '');

      if v_provider_id is null and v_fingerprint is not null then
        v_provider_id := 'csv:' || v_fingerprint;
      end if;

      if v_provider_id is null then
        raise exception 'Each imported transaction requires provider_transaction_id or import_fingerprint';
      end if;

      insert into public.teller_bank_transactions (
        organization_id,
        bank_account_id,
        external_transaction_id,
        provider_transaction_id,
        provider_pending_transaction_id,
        posted_date,
        authorized_date,
        amount,
        name,
        merchant_name,
        pending,
        description,
        transaction_type,
        raw_provider_metadata,
        import_fingerprint,
        csv_import_batch_id,
        provider_lifecycle_state,
        metadata
      )
      values (
        p_organization_id,
        p_bank_account_id,
        v_provider_id,
        v_provider_id,
        v_pending_id,
        coalesce((v_item->>'posted_date')::date, current_date),
        nullif(v_item->>'authorized_date', '')::date,
        round(
          coalesce(
            (v_item->>'raw_amount')::numeric,
            (v_item->>'amount')::numeric,
            0
          )::numeric,
          2
        ),
        coalesce(v_item->>'name', v_item->>'description', ''),
        nullif(v_item->>'merchant_name', ''),
        v_is_pending,
        coalesce(v_item->>'description', v_item->>'name', ''),
        nullif(v_item->>'transaction_type', ''),
        coalesce(v_item->'raw_provider_metadata', '{}'::jsonb),
        v_fingerprint,
        p_import_batch_id,
        'active',
        jsonb_build_object(
          'provider', coalesce(p_provider, 'unknown'),
          'import_source', case when v_fingerprint is not null then 'csv' else 'provider' end
        )
      )
      on conflict (organization_id, bank_account_id, external_transaction_id)
      do update set
        provider_pending_transaction_id = excluded.provider_pending_transaction_id,
        posted_date = excluded.posted_date,
        authorized_date = excluded.authorized_date,
        amount = excluded.amount,
        name = excluded.name,
        merchant_name = excluded.merchant_name,
        pending = excluded.pending,
        description = excluded.description,
        transaction_type = excluded.transaction_type,
        raw_provider_metadata = excluded.raw_provider_metadata,
        import_fingerprint = coalesce(excluded.import_fingerprint, public.teller_bank_transactions.import_fingerprint),
        csv_import_batch_id = coalesce(excluded.csv_import_batch_id, public.teller_bank_transactions.csv_import_batch_id),
        provider_lifecycle_state = case
          when public.teller_bank_transactions.provider_lifecycle_state = 'provider_removed' then 'provider_removed'
          else 'active'
        end,
        updated_at = now()
      returning id, (xmax = 0) into v_txn_id, v_was_insert;

      if v_was_insert then
        v_imported := v_imported + 1;
      else
        v_updated := v_updated + 1;
      end if;

      if not v_is_pending then
        if v_pending_id is not null then
          update public.teller_bank_transactions old
          set
            provider_lifecycle_state = 'superseded',
            superseded_by_transaction_id = v_txn_id,
            updated_at = now()
          where old.organization_id = p_organization_id
            and old.bank_account_id = p_bank_account_id
            and old.external_transaction_id = v_pending_id
            and old.provider_lifecycle_state = 'active'
            and old.id <> v_txn_id;

          if found then
            v_superseded := v_superseded + 1;
          end if;
        end if;

        update public.teller_bank_transactions old
        set
          provider_lifecycle_state = 'superseded',
          superseded_by_transaction_id = v_txn_id,
          updated_at = now()
        where old.organization_id = p_organization_id
          and old.bank_account_id = p_bank_account_id
          and old.pending = true
          and old.provider_lifecycle_state = 'active'
          and old.id <> v_txn_id
          and (
            old.external_transaction_id = v_pending_id
            or old.provider_pending_transaction_id = v_provider_id
          );

        if found then
          v_superseded := v_superseded + 1;
        end if;
      end if;
    end loop;
  end if;

  if p_removed_provider_ids is not null and cardinality(p_removed_provider_ids) > 0 then
    v_provider_id_list := p_removed_provider_ids;

    update public.teller_bank_transactions t
    set
      provider_lifecycle_state = 'provider_removed',
      updated_at = now()
    where t.organization_id = p_organization_id
      and t.bank_account_id = p_bank_account_id
      and t.external_transaction_id = any (v_provider_id_list)
      and t.provider_lifecycle_state = 'active';

    get diagnostics v_removed = ROW_COUNT;
  end if;

  if p_import_batch_id is not null then
    update public.teller_bank_import_batches
    set
      status = 'completed',
      row_count = coalesce(jsonb_array_length(p_transactions), 0),
      imported_count = v_imported + v_updated,
      duplicate_count = v_duplicate,
      completed_at = now()
    where id = p_import_batch_id
      and organization_id = p_organization_id;
  end if;

  return jsonb_build_object(
    'imported', v_imported,
    'updated', v_updated,
    'superseded', v_superseded,
    'removed', v_removed,
    'duplicates_skipped', v_duplicate
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Confirm bank match (no journal)
-- ---------------------------------------------------------------------------

create or replace function public.teller_confirm_bank_match(
  p_organization_id uuid,
  p_bank_transaction_id uuid,
  p_matched_resource_type text,
  p_matched_resource_id uuid,
  p_matched_amount numeric,
  p_idempotency_event_id text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_txn public.teller_bank_transactions%rowtype;
  v_amount numeric(14, 2);
  v_txn_total numeric(14, 2);
  v_txn_matched numeric(14, 2);
  v_resource_matched numeric(14, 2);
  v_resource_total numeric(14, 2);
  v_existing public.teller_bank_matches%rowtype;
  v_match public.teller_bank_matches%rowtype;
  v_next_status text;
begin
  v_amount := round(p_matched_amount::numeric, 2);

  if v_amount <= 0 then
    raise exception 'Matched amount must be greater than zero';
  end if;

  if coalesce(trim(p_idempotency_event_id), '') = '' then
    raise exception 'Idempotency event id is required';
  end if;

  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to confirm bank match';
  end if;

  select * into v_existing
  from public.teller_bank_matches
  where organization_id = p_organization_id
    and idempotency_event_id = p_idempotency_event_id
    and status = 'confirmed';

  if found then
    if v_existing.bank_transaction_id <> p_bank_transaction_id
       or v_existing.matched_resource_type <> p_matched_resource_type
       or v_existing.matched_resource_id <> p_matched_resource_id
       or round(v_existing.matched_amount, 2) <> v_amount then
      raise exception 'Idempotency conflict: event is tied to a different match';
    end if;

    return jsonb_build_object(
      'match_id', v_existing.id,
      'bank_transaction_id', v_existing.bank_transaction_id,
      'status', (
        select status
        from public.teller_bank_transactions
        where id = v_existing.bank_transaction_id
      ),
      'duplicate', true
    );
  end if;

  select * into v_txn
  from public.teller_bank_transactions
  where id = p_bank_transaction_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Bank transaction not found in organization';
  end if;

  if v_txn.provider_lifecycle_state in ('provider_removed', 'superseded') then
    raise exception 'Cannot match inactive bank transaction lifecycle state';
  end if;

  if v_txn.status in ('excluded', 'reconciled', 'categorized') then
    raise exception 'Bank transaction status % cannot be matched', v_txn.status;
  end if;

  perform public.teller_assert_bank_matchable_resource(
    p_organization_id,
    p_matched_resource_type,
    p_matched_resource_id
  );

  v_txn_total := round(abs(coalesce(v_txn.normalized_amount, 0))::numeric, 2);
  v_txn_matched := public.teller_bank_tx_confirmed_match_total(v_txn.id);

  if v_txn_matched + v_amount > v_txn_total + 0.009 then
    raise exception 'Match would exceed bank transaction amount (matched %, target %)', v_txn_matched + v_amount, v_txn_total;
  end if;

  v_resource_matched := public.teller_bank_resource_confirmed_match_total(
    p_organization_id,
    p_matched_resource_type,
    p_matched_resource_id
  );

  v_resource_total := null;
  case p_matched_resource_type
    when 'customer_payment', 'bill_payment', 'expense_payment', 'customer_deposit', 'deposit_refund', 'credit_refund' then
      select round(p.amount, 2) into v_resource_total
      from public.teller_payments p
      where p.id = p_matched_resource_id
        and p.organization_id = p_organization_id;
    when 'document' then
      select round(d.total, 2) into v_resource_total
      from public.teller_documents d
      where d.id = p_matched_resource_id
        and d.organization_id = p_organization_id;
    when 'bank_transfer' then
      select round(t.amount, 2) into v_resource_total
      from public.teller_bank_transfers t
      where t.id = p_matched_resource_id
        and t.organization_id = p_organization_id;
    else
      v_resource_total := null;
  end case;

  if v_resource_total is not null
     and v_resource_matched + v_amount > v_resource_total + 0.009 then
    raise exception 'Match would exceed resource amount (matched %, target %)', v_resource_matched + v_amount, v_resource_total;
  end if;

  insert into public.teller_bank_matches (
    organization_id,
    bank_transaction_id,
    matched_resource_type,
    matched_resource_id,
    matched_amount,
    status,
    match_method,
    idempotency_event_id,
    created_by,
    confirmed_at
  )
  values (
    p_organization_id,
    v_txn.id,
    p_matched_resource_type,
    p_matched_resource_id,
    v_amount,
    'confirmed',
    'manual',
    p_idempotency_event_id,
    coalesce(p_actor_id, auth.uid()),
    now()
  )
  returning * into v_match;

  v_next_status := public.teller_recalc_bank_transaction_status(v_txn.id);

  insert into public.teller_audit_events (
    organization_id,
    actor_id,
    action,
    resource_kind,
    resource_id,
    metadata
  )
  values (
    p_organization_id,
    coalesce(p_actor_id, auth.uid()),
    'bank_match.confirmed',
    'bank_match',
    v_match.id,
    jsonb_build_object(
      'bank_transaction_id', v_txn.id,
      'matched_resource_type', p_matched_resource_type,
      'matched_resource_id', p_matched_resource_id,
      'matched_amount', v_amount,
      'transaction_status', v_next_status,
      'idempotency_event_id', p_idempotency_event_id
    )
  );

  return jsonb_build_object(
    'match_id', v_match.id,
    'bank_transaction_id', v_txn.id,
    'status', v_next_status,
    'duplicate', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Remove bank match (append-only removal)
-- ---------------------------------------------------------------------------

create or replace function public.teller_remove_bank_match(
  p_organization_id uuid,
  p_match_id uuid,
  p_actor_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_match public.teller_bank_matches%rowtype;
  v_next_status text;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Removal reason is required';
  end if;

  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to remove bank match';
  end if;

  select * into v_match
  from public.teller_bank_matches
  where id = p_match_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Bank match not found in organization';
  end if;

  if v_match.status = 'removed' then
    return jsonb_build_object(
      'match_id', v_match.id,
      'bank_transaction_id', v_match.bank_transaction_id,
      'status', (
        select status
        from public.teller_bank_transactions
        where id = v_match.bank_transaction_id
      ),
      'duplicate', true
    );
  end if;

  if v_match.status <> 'confirmed' then
    raise exception 'Only confirmed bank matches can be removed';
  end if;

  update public.teller_bank_matches
  set
    status = 'removed',
    removed_at = now(),
    removed_by = coalesce(p_actor_id, auth.uid())
  where id = v_match.id;

  perform 1
  from public.teller_bank_transactions
  where id = v_match.bank_transaction_id
    and organization_id = p_organization_id
  for update;

  v_next_status := public.teller_recalc_bank_transaction_status(v_match.bank_transaction_id);

  insert into public.teller_audit_events (
    organization_id,
    actor_id,
    action,
    resource_kind,
    resource_id,
    metadata
  )
  values (
    p_organization_id,
    coalesce(p_actor_id, auth.uid()),
    'bank_match.removed',
    'bank_match',
    v_match.id,
    jsonb_build_object(
      'bank_transaction_id', v_match.bank_transaction_id,
      'matched_resource_type', v_match.matched_resource_type,
      'matched_resource_id', v_match.matched_resource_id,
      'matched_amount', v_match.matched_amount,
      'reason', p_reason,
      'transaction_status', v_next_status
    )
  );

  return jsonb_build_object(
    'match_id', v_match.id,
    'bank_transaction_id', v_match.bank_transaction_id,
    'status', v_next_status,
    'duplicate', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Exclude bank transaction from review queue
-- ---------------------------------------------------------------------------

create or replace function public.teller_exclude_bank_transaction(
  p_organization_id uuid,
  p_bank_transaction_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_txn public.teller_bank_transactions%rowtype;
begin
  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to exclude bank transaction';
  end if;

  select * into v_txn
  from public.teller_bank_transactions
  where id = p_bank_transaction_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Bank transaction not found in organization';
  end if;

  if v_txn.status = 'reconciled' then
    raise exception 'Reconciled bank transactions cannot be excluded';
  end if;

  if v_txn.status = 'categorized' then
    raise exception 'Categorized bank transactions cannot be excluded';
  end if;

  update public.teller_bank_transactions
  set
    status = 'excluded',
    updated_at = now()
  where id = v_txn.id;

  insert into public.teller_audit_events (
    organization_id,
    actor_id,
    action,
    resource_kind,
    resource_id,
    metadata
  )
  values (
    p_organization_id,
    coalesce(p_actor_id, auth.uid()),
    'bank_transaction.excluded',
    'bank_transaction',
    v_txn.id,
    jsonb_build_object('prior_status', v_txn.status)
  );

  return jsonb_build_object(
    'bank_transaction_id', v_txn.id,
    'status', 'excluded'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant execute on function public.teller_bank_tx_confirmed_match_total(uuid) to authenticated, service_role;
grant execute on function public.teller_bank_resource_confirmed_match_total(uuid, text, uuid) to authenticated, service_role;
grant execute on function public.teller_assert_bank_matchable_resource(uuid, text, uuid) to authenticated, service_role;
grant execute on function public.teller_recalc_bank_transaction_status(uuid) to authenticated, service_role;
grant execute on function public.teller_import_bank_transactions(uuid, uuid, text, jsonb, text[], uuid) to authenticated, service_role;
grant execute on function public.teller_confirm_bank_match(uuid, uuid, text, uuid, numeric, text, uuid) to authenticated, service_role;
grant execute on function public.teller_remove_bank_match(uuid, uuid, uuid, text) to authenticated, service_role;
grant execute on function public.teller_exclude_bank_transaction(uuid, uuid, uuid) to authenticated, service_role;
