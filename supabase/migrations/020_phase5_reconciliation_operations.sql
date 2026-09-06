-- Phase 5C: Banking categorization, transfers, and reconciliation operations
-- Journal-posting workflows; builds on 018/019.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.teller_next_expense_number(
  p_organization_id uuid
)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select 'EXP-' || (
    coalesce(
      max(
        nullif(substring(d.number from '(\d+)\s*$'), '')::integer
      ),
      1000
    ) + 1
  )::text
  from public.teller_documents d
  where d.organization_id = p_organization_id
    and d.kind = 'expense';
$$;

create or replace function public.teller_assert_org_postable_account(
  p_organization_id uuid,
  p_account_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1
    from public.teller_accounts a
    where a.id = p_account_id
      and a.organization_id = p_organization_id
      and not a.archived
  ) then
    raise exception 'Account % is invalid for organization', p_account_id;
  end if;
end;
$$;

create or replace function public.teller_bank_reconciliation_prior_ending_balance(
  p_organization_id uuid,
  p_bank_account_id uuid,
  p_statement_start_date date
)
returns numeric
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    (
      select r.statement_ending_balance
      from public.teller_bank_reconciliations r
      where r.organization_id = p_organization_id
        and r.bank_account_id = p_bank_account_id
        and r.status = 'completed'
        and r.statement_end_date < p_statement_start_date
      order by r.statement_end_date desc
      limit 1
    ),
    0
  );
$$;

create or replace function public.teller_bank_reconciliation_net_cleared(
  p_reconciliation_id uuid
)
returns numeric
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(round(sum(signed_amount)::numeric, 2), 0)
  from (
    select
      case
        when ri.bank_transaction_id is not null then t.normalized_amount
        when ri.journal_line_id is not null then
          coalesce(jl.debit, 0) - coalesce(jl.credit, 0)
        when ri.journal_entry_id is not null then (
          select coalesce(sum(coalesce(jl2.debit, 0) - coalesce(jl2.credit, 0)), 0)
          from public.teller_journal_lines jl2
          where jl2.entry_id = ri.journal_entry_id
            and jl2.account_id = ba.gl_account_id
        )
        else 0
      end as signed_amount
    from public.teller_bank_reconciliation_items ri
    inner join public.teller_bank_reconciliations r
      on r.id = ri.reconciliation_id
    inner join public.teller_bank_accounts ba
      on ba.id = r.bank_account_id
    left join public.teller_bank_transactions t
      on t.id = ri.bank_transaction_id
    left join public.teller_journal_lines jl
      on jl.id = ri.journal_line_id
      and jl.account_id = ba.gl_account_id
    where ri.reconciliation_id = p_reconciliation_id
  ) amounts;
$$;

create or replace function public.teller_bank_reconciliation_difference(
  p_reconciliation_id uuid
)
returns numeric
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select round(
    (
      r.statement_ending_balance
      - (
        coalesce(
          nullif(r.beginning_reconciled_balance, 0),
          public.teller_bank_reconciliation_prior_ending_balance(
            r.organization_id,
            r.bank_account_id,
            r.statement_start_date
          )
        )
        + public.teller_bank_reconciliation_net_cleared(r.id)
      )
    )::numeric,
    2
  )
  from public.teller_bank_reconciliations r
  where r.id = p_reconciliation_id;
$$;

-- ---------------------------------------------------------------------------
-- Categorize bank transaction (posts journal + confirmed match)
-- ---------------------------------------------------------------------------

create or replace function public.teller_categorize_bank_transaction(
  p_organization_id uuid,
  p_bank_transaction_id uuid,
  p_category_kind text,
  p_account_id uuid,
  p_party_id uuid,
  p_job_id uuid,
  p_memo text,
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
  v_bank_account public.teller_bank_accounts%rowtype;
  v_gl_kind text;
  v_amount numeric(14, 2);
  v_closed_through date;
  v_existing public.teller_bank_matches%rowtype;
  v_document_id uuid;
  v_document_number text;
  v_entry_id uuid;
  v_match public.teller_bank_matches%rowtype;
  v_lines jsonb;
  v_resource_type text;
  v_resource_id uuid;
  v_source_kind text;
  v_description text;
begin
  if coalesce(trim(p_idempotency_event_id), '') = '' then
    raise exception 'Idempotency event id is required';
  end if;

  if p_category_kind not in (
    'expense',
    'bank_fee',
    'interest_income',
    'interest_expense',
    'owner_contribution',
    'owner_draw'
  ) then
    raise exception 'Unsupported category kind: %', p_category_kind;
  end if;

  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to categorize bank transaction';
  end if;

  select * into v_existing
  from public.teller_bank_matches
  where organization_id = p_organization_id
    and idempotency_event_id = p_idempotency_event_id
    and status = 'confirmed';

  if found then
    return jsonb_build_object(
      'bank_transaction_id', v_existing.bank_transaction_id,
      'match_id', v_existing.id,
      'matched_resource_type', v_existing.matched_resource_type,
      'matched_resource_id', v_existing.matched_resource_id,
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
    raise exception 'Cannot categorize inactive bank transaction';
  end if;

  if v_txn.status in ('excluded', 'reconciled', 'categorized') then
    raise exception 'Bank transaction status % cannot be categorized', v_txn.status;
  end if;

  if coalesce(v_txn.normalized_amount, 0) = 0 then
    raise exception 'Cannot categorize zero-amount bank transaction';
  end if;

  select * into v_bank_account
  from public.teller_bank_accounts
  where id = v_txn.bank_account_id
    and organization_id = p_organization_id;

  if v_bank_account.gl_account_id is null then
    raise exception 'Bank account is missing a linked GL account';
  end if;

  perform public.teller_assert_org_postable_account(p_organization_id, p_account_id);
  perform public.teller_assert_org_party(p_organization_id, p_party_id);

  if p_job_id is not null and not exists (
    select 1
    from public.teller_jobs j
    where j.id = p_job_id
      and j.organization_id = p_organization_id
  ) then
    raise exception 'Job % does not belong to organization', p_job_id;
  end if;

  v_closed_through := public.teller_books_closed_through(p_organization_id);
  if v_closed_through is not null and v_txn.posted_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  v_gl_kind := public.teller_bank_account_gl_kind(v_txn.bank_account_id);
  v_amount := round(abs(v_txn.normalized_amount)::numeric, 2);
  v_description := coalesce(nullif(trim(p_memo), ''), v_txn.description, v_txn.name, 'Bank transaction');

  if v_gl_kind = 'credit_card_liability' and v_txn.normalized_amount < 0 then
    raise exception 'Credit card payments must be matched, not categorized';
  end if;

  if p_category_kind = 'expense' then
    v_document_number := public.teller_next_expense_number(p_organization_id);

    insert into public.teller_documents (
      organization_id,
      kind,
      number,
      party_id,
      job_id,
      status,
      issue_date,
      due_date,
      subtotal,
      tax,
      total,
      amount_paid,
      memo
    )
    values (
      p_organization_id,
      'expense',
      v_document_number,
      p_party_id,
      p_job_id,
      'paid',
      v_txn.posted_date,
      null,
      v_amount,
      0,
      v_amount,
      v_amount,
      v_description
    )
    returning id into v_document_id;

    insert into public.teller_document_lines (
      document_id,
      description,
      quantity,
      unit_price,
      amount,
      account_id,
      item_type,
      sort_order
    )
    values (
      v_document_id,
      v_description,
      1,
      v_amount,
      v_amount,
      p_account_id,
      'expense',
      0
    );

    v_resource_type := 'document';
    v_resource_id := v_document_id;
    v_source_kind := 'expense';

    if v_gl_kind = 'asset_bank' then
      if v_txn.normalized_amount < 0 then
        v_lines := jsonb_build_array(
          jsonb_build_object(
            'account_id', p_account_id,
            'debit', v_amount,
            'credit', 0,
            'party_id', p_party_id,
            'job_id', p_job_id,
            'memo', v_description
          ),
          jsonb_build_object(
            'account_id', v_bank_account.gl_account_id,
            'debit', 0,
            'credit', v_amount,
            'party_id', p_party_id,
            'job_id', p_job_id,
            'memo', 'Bank expense'
          )
        );
      else
        raise exception 'Expense category requires an outflow bank transaction';
      end if;
    else
      v_lines := jsonb_build_array(
        jsonb_build_object(
          'account_id', p_account_id,
          'debit', v_amount,
          'credit', 0,
          'party_id', p_party_id,
          'job_id', p_job_id,
          'memo', v_description
        ),
        jsonb_build_object(
          'account_id', v_bank_account.gl_account_id,
          'debit', 0,
          'credit', v_amount,
          'party_id', p_party_id,
          'job_id', p_job_id,
          'memo', 'Credit card expense'
        )
      );
    end if;

    v_entry_id := public.teller_post_journal(
      p_organization_id,
      v_txn.posted_date,
      'Expense ' || v_document_number,
      v_source_kind,
      v_document_id,
      null,
      v_lines
    );

    update public.teller_documents
    set posted_entry_id = v_entry_id
    where id = v_document_id;

    insert into public.teller_document_journal_links (
      organization_id,
      document_id,
      journal_entry_id,
      link_kind
    )
    values (
      p_organization_id,
      v_document_id,
      v_entry_id,
      'accrual'
    )
    on conflict (document_id, journal_entry_id) do nothing;
  else
    v_resource_type := p_category_kind;
    v_source_kind := 'bank-' || replace(p_category_kind, '_', '-');

    if v_gl_kind = 'asset_bank' then
      if v_txn.normalized_amount < 0 then
        v_lines := jsonb_build_array(
          jsonb_build_object(
            'account_id', p_account_id,
            'debit', v_amount,
            'credit', 0,
            'party_id', p_party_id,
            'job_id', p_job_id,
            'memo', v_description
          ),
          jsonb_build_object(
            'account_id', v_bank_account.gl_account_id,
            'debit', 0,
            'credit', v_amount,
            'party_id', p_party_id,
            'job_id', p_job_id,
            'memo', v_description
          )
        );
      else
        v_lines := jsonb_build_array(
          jsonb_build_object(
            'account_id', v_bank_account.gl_account_id,
            'debit', v_amount,
            'credit', 0,
            'party_id', p_party_id,
            'job_id', p_job_id,
            'memo', v_description
          ),
          jsonb_build_object(
            'account_id', p_account_id,
            'debit', 0,
            'credit', v_amount,
            'party_id', p_party_id,
            'job_id', p_job_id,
            'memo', v_description
          )
        );
      end if;
    else
      v_lines := jsonb_build_array(
        jsonb_build_object(
          'account_id', p_account_id,
          'debit', v_amount,
          'credit', 0,
          'party_id', p_party_id,
          'job_id', p_job_id,
          'memo', v_description
        ),
        jsonb_build_object(
          'account_id', v_bank_account.gl_account_id,
          'debit', 0,
          'credit', v_amount,
          'party_id', p_party_id,
          'job_id', p_job_id,
          'memo', v_description
        )
      );
    end if;

    v_entry_id := public.teller_post_journal(
      p_organization_id,
      v_txn.posted_date,
      v_description,
      v_source_kind,
      null,
      null,
      v_lines
    );

    v_resource_id := v_entry_id;
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
    v_resource_type,
    v_resource_id,
    v_amount,
    'confirmed',
    'categorize',
    p_idempotency_event_id,
    coalesce(p_actor_id, auth.uid()),
    now()
  )
  returning * into v_match;

  update public.teller_bank_transactions
  set
    status = 'categorized',
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
    'bank_transaction.categorized',
    'bank_transaction',
    v_txn.id,
    jsonb_build_object(
      'category_kind', p_category_kind,
      'account_id', p_account_id,
      'journal_entry_id', v_entry_id,
      'match_id', v_match.id,
      'matched_resource_type', v_resource_type,
      'matched_resource_id', v_resource_id,
      'amount', v_amount,
      'idempotency_event_id', p_idempotency_event_id
    )
  );

  return jsonb_build_object(
    'bank_transaction_id', v_txn.id,
    'status', 'categorized',
    'journal_entry_id', v_entry_id,
    'match_id', v_match.id,
    'matched_resource_type', v_resource_type,
    'matched_resource_id', v_resource_id,
    'document_id', v_document_id,
    'duplicate', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Split categorize — one journal, many category lines
-- ---------------------------------------------------------------------------

create or replace function public.teller_split_categorize_bank_transaction(
  p_organization_id uuid,
  p_bank_transaction_id uuid,
  p_splits jsonb,
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
  v_bank_account public.teller_bank_accounts%rowtype;
  v_gl_kind text;
  v_target numeric(14, 2);
  v_split_total numeric(14, 2) := 0;
  v_split jsonb;
  v_amount numeric(14, 2);
  v_closed_through date;
  v_existing public.teller_bank_matches%rowtype;
  v_lines jsonb := '[]'::jsonb;
  v_bank_line jsonb;
  v_entry_id uuid;
  v_match public.teller_bank_matches%rowtype;
  v_split_id uuid;
  v_memo text;
begin
  if coalesce(trim(p_idempotency_event_id), '') = '' then
    raise exception 'Idempotency event id is required';
  end if;

  if p_splits is null or jsonb_typeof(p_splits) <> 'array' or jsonb_array_length(p_splits) = 0 then
    raise exception 'At least one split is required';
  end if;

  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to split categorize bank transaction';
  end if;

  select * into v_existing
  from public.teller_bank_matches
  where organization_id = p_organization_id
    and idempotency_event_id = p_idempotency_event_id
    and status = 'confirmed';

  if found then
    return jsonb_build_object(
      'bank_transaction_id', v_existing.bank_transaction_id,
      'match_id', v_existing.id,
      'matched_resource_id', v_existing.matched_resource_id,
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
    raise exception 'Cannot categorize inactive bank transaction';
  end if;

  if v_txn.status in ('excluded', 'reconciled', 'categorized') then
    raise exception 'Bank transaction status % cannot be categorized', v_txn.status;
  end if;

  if coalesce(v_txn.normalized_amount, 0) = 0 then
    raise exception 'Cannot categorize zero-amount bank transaction';
  end if;

  select * into v_bank_account
  from public.teller_bank_accounts
  where id = v_txn.bank_account_id
    and organization_id = p_organization_id;

  if v_bank_account.gl_account_id is null then
    raise exception 'Bank account is missing a linked GL account';
  end if;

  v_gl_kind := public.teller_bank_account_gl_kind(v_txn.bank_account_id);
  v_target := round(abs(v_txn.normalized_amount)::numeric, 2);

  if v_gl_kind = 'credit_card_liability' and v_txn.normalized_amount < 0 then
    raise exception 'Credit card payments must be matched, not categorized';
  end if;

  v_closed_through := public.teller_books_closed_through(p_organization_id);
  if v_closed_through is not null and v_txn.posted_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  for v_split in select value from jsonb_array_elements(p_splits) loop
    v_amount := round(coalesce((v_split->>'amount')::numeric, 0)::numeric, 2);

    if v_amount <= 0 then
      raise exception 'Each split amount must be greater than zero';
    end if;

    perform public.teller_assert_org_postable_account(
      p_organization_id,
      (v_split->>'account_id')::uuid
    );
    perform public.teller_assert_org_party(
      p_organization_id,
      nullif(v_split->>'party_id', '')::uuid
    );

    if nullif(v_split->>'job_id', '') is not null
       and not exists (
         select 1
         from public.teller_jobs j
         where j.id = (v_split->>'job_id')::uuid
           and j.organization_id = p_organization_id
       ) then
      raise exception 'Split job does not belong to organization';
    end if;

    v_split_total := v_split_total + v_amount;
    v_memo := coalesce(nullif(trim(v_split->>'memo'), ''), v_txn.description, 'Bank split');

    if (v_gl_kind = 'asset_bank' and v_txn.normalized_amount < 0)
       or (v_gl_kind = 'credit_card_liability' and v_txn.normalized_amount > 0) then
      v_lines := v_lines || jsonb_build_object(
        'account_id', (v_split->>'account_id')::uuid,
        'debit', v_amount,
        'credit', 0,
        'party_id', nullif(v_split->>'party_id', '')::uuid,
        'job_id', nullif(v_split->>'job_id', '')::uuid,
        'memo', v_memo
      );
    else
      v_lines := v_lines || jsonb_build_object(
        'account_id', (v_split->>'account_id')::uuid,
        'debit', 0,
        'credit', v_amount,
        'party_id', nullif(v_split->>'party_id', '')::uuid,
        'job_id', nullif(v_split->>'job_id', '')::uuid,
        'memo', v_memo
      );
    end if;
  end loop;

  if abs(v_split_total - v_target) > 0.009 then
    raise exception 'Split total % must equal bank transaction amount %', v_split_total, v_target;
  end if;

  if (v_gl_kind = 'asset_bank' and v_txn.normalized_amount < 0)
     or (v_gl_kind = 'credit_card_liability' and v_txn.normalized_amount > 0) then
    v_bank_line := jsonb_build_object(
      'account_id', v_bank_account.gl_account_id,
      'debit', 0,
      'credit', v_target,
      'memo', coalesce(v_txn.description, 'Bank split')
    );
  else
    v_bank_line := jsonb_build_object(
      'account_id', v_bank_account.gl_account_id,
      'debit', v_target,
      'credit', 0,
      'memo', coalesce(v_txn.description, 'Bank split')
    );
  end if;

  v_lines := v_lines || v_bank_line;

  v_entry_id := public.teller_post_journal(
    p_organization_id,
    v_txn.posted_date,
    coalesce(v_txn.description, v_txn.name, 'Split bank transaction'),
    'bank-split',
    null,
    null,
    v_lines
  );

  for v_split in select value from jsonb_array_elements(p_splits) loop
    insert into public.teller_bank_transaction_splits (
      organization_id,
      bank_transaction_id,
      account_id,
      party_id,
      job_id,
      amount,
      memo,
      posted_journal_entry_id
    )
    values (
      p_organization_id,
      v_txn.id,
      (v_split->>'account_id')::uuid,
      nullif(v_split->>'party_id', '')::uuid,
      nullif(v_split->>'job_id', '')::uuid,
      round((v_split->>'amount')::numeric, 2),
      coalesce(nullif(trim(v_split->>'memo'), ''), v_txn.description, ''),
      v_entry_id
    )
    returning id into v_split_id;
  end loop;

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
    'journal_entry',
    v_entry_id,
    v_target,
    'confirmed',
    'split_categorize',
    p_idempotency_event_id,
    coalesce(p_actor_id, auth.uid()),
    now()
  )
  returning * into v_match;

  update public.teller_bank_transactions
  set
    status = 'categorized',
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
    'bank_transaction.split_categorized',
    'bank_transaction',
    v_txn.id,
    jsonb_build_object(
      'journal_entry_id', v_entry_id,
      'match_id', v_match.id,
      'split_count', jsonb_array_length(p_splits),
      'amount', v_target,
      'idempotency_event_id', p_idempotency_event_id
    )
  );

  return jsonb_build_object(
    'bank_transaction_id', v_txn.id,
    'status', 'categorized',
    'journal_entry_id', v_entry_id,
    'match_id', v_match.id,
    'duplicate', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Inter-account bank transfer
-- ---------------------------------------------------------------------------

create or replace function public.teller_create_bank_transfer(
  p_organization_id uuid,
  p_source_bank_transaction_id uuid,
  p_destination_bank_transaction_id uuid,
  p_amount numeric,
  p_transfer_date date,
  p_idempotency_event_id text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_amount numeric(14, 2);
  v_source_txn public.teller_bank_transactions%rowtype;
  v_dest_txn public.teller_bank_transactions%rowtype;
  v_source_account public.teller_bank_accounts%rowtype;
  v_dest_account public.teller_bank_accounts%rowtype;
  v_closed_through date;
  v_existing public.teller_bank_transfers%rowtype;
  v_transfer public.teller_bank_transfers%rowtype;
  v_entry_id uuid;
  v_lines jsonb;
  v_source_match_id uuid;
  v_dest_match_id uuid;
begin
  v_amount := round(p_amount::numeric, 2);

  if v_amount <= 0 then
    raise exception 'Transfer amount must be greater than zero';
  end if;

  if p_source_bank_transaction_id = p_destination_bank_transaction_id then
    raise exception 'Source and destination bank transactions must differ';
  end if;

  if coalesce(trim(p_idempotency_event_id), '') = '' then
    raise exception 'Idempotency event id is required';
  end if;

  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to create bank transfer';
  end if;

  select * into v_existing
  from public.teller_bank_transfers
  where organization_id = p_organization_id
    and idempotency_event_id = p_idempotency_event_id
    and status = 'confirmed';

  if found then
    return jsonb_build_object(
      'transfer_id', v_existing.id,
      'journal_entry_id', v_existing.journal_entry_id,
      'duplicate', true
    );
  end if;

  if p_source_bank_transaction_id < p_destination_bank_transaction_id then
    select * into v_source_txn
    from public.teller_bank_transactions
    where id = p_source_bank_transaction_id
      and organization_id = p_organization_id
    for update;

    select * into v_dest_txn
    from public.teller_bank_transactions
    where id = p_destination_bank_transaction_id
      and organization_id = p_organization_id
    for update;
  else
    select * into v_dest_txn
    from public.teller_bank_transactions
    where id = p_destination_bank_transaction_id
      and organization_id = p_organization_id
    for update;

    select * into v_source_txn
    from public.teller_bank_transactions
    where id = p_source_bank_transaction_id
      and organization_id = p_organization_id
    for update;
  end if;

  if v_source_txn.id is null or v_dest_txn.id is null then
    raise exception 'Both bank transactions must belong to the organization';
  end if;

  if v_source_txn.provider_lifecycle_state in ('provider_removed', 'superseded')
     or v_dest_txn.provider_lifecycle_state in ('provider_removed', 'superseded') then
    raise exception 'Cannot transfer inactive bank transactions';
  end if;

  if v_source_txn.status in ('excluded', 'reconciled')
     or v_dest_txn.status in ('excluded', 'reconciled') then
    raise exception 'Excluded or reconciled bank transactions cannot be transferred';
  end if;

  select * into v_source_account
  from public.teller_bank_accounts
  where id = v_source_txn.bank_account_id
    and organization_id = p_organization_id;

  select * into v_dest_account
  from public.teller_bank_accounts
  where id = v_dest_txn.bank_account_id
    and organization_id = p_organization_id;

  if v_source_account.id = v_dest_account.id then
    raise exception 'Source and destination bank accounts must differ';
  end if;

  if v_source_account.gl_account_id is null or v_dest_account.gl_account_id is null then
    raise exception 'Both bank accounts require linked GL accounts';
  end if;

  v_closed_through := public.teller_books_closed_through(p_organization_id);
  if v_closed_through is not null and p_transfer_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', v_dest_account.gl_account_id,
      'debit', v_amount,
      'credit', 0,
      'memo', 'Bank transfer in'
    ),
    jsonb_build_object(
      'account_id', v_source_account.gl_account_id,
      'debit', 0,
      'credit', v_amount,
      'memo', 'Bank transfer out'
    )
  );

  v_entry_id := public.teller_post_journal(
    p_organization_id,
    p_transfer_date,
    'Bank transfer',
    'bank-transfer',
    null,
    null,
    v_lines
  );

  insert into public.teller_bank_transfers (
    organization_id,
    source_bank_transaction_id,
    destination_bank_transaction_id,
    source_bank_account_id,
    destination_bank_account_id,
    journal_entry_id,
    amount,
    transfer_date,
    status,
    idempotency_event_id,
    created_by
  )
  values (
    p_organization_id,
    v_source_txn.id,
    v_dest_txn.id,
    v_source_account.id,
    v_dest_account.id,
    v_entry_id,
    v_amount,
    p_transfer_date,
    'confirmed',
    p_idempotency_event_id,
    coalesce(p_actor_id, auth.uid())
  )
  returning * into v_transfer;

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
    v_source_txn.id,
    'bank_transfer',
    v_transfer.id,
    v_amount,
    'confirmed',
    'transfer',
    p_idempotency_event_id || ':source',
    coalesce(p_actor_id, auth.uid()),
    now()
  )
  returning id into v_source_match_id;

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
    v_dest_txn.id,
    'bank_transfer',
    v_transfer.id,
    v_amount,
    'confirmed',
    'transfer',
    p_idempotency_event_id || ':dest',
    coalesce(p_actor_id, auth.uid()),
    now()
  )
  returning id into v_dest_match_id;

  update public.teller_bank_transactions
  set status = 'matched', updated_at = now()
  where id in (v_source_txn.id, v_dest_txn.id);

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
    'bank_transfer.created',
    'bank_transfer',
    v_transfer.id,
    jsonb_build_object(
      'source_bank_transaction_id', v_source_txn.id,
      'destination_bank_transaction_id', v_dest_txn.id,
      'journal_entry_id', v_entry_id,
      'amount', v_amount,
      'source_match_id', v_source_match_id,
      'destination_match_id', v_dest_match_id,
      'idempotency_event_id', p_idempotency_event_id
    )
  );

  return jsonb_build_object(
    'transfer_id', v_transfer.id,
    'journal_entry_id', v_entry_id,
    'source_match_id', v_source_match_id,
    'destination_match_id', v_dest_match_id,
    'duplicate', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Finalize bank reconciliation
-- ---------------------------------------------------------------------------

create or replace function public.teller_finalize_bank_reconciliation(
  p_organization_id uuid,
  p_reconciliation_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_recon public.teller_bank_reconciliations%rowtype;
  v_difference numeric(14, 2);
  v_beginning numeric(14, 2);
  v_cleared numeric(14, 2);
  v_txn_id uuid;
begin
  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to finalize bank reconciliation';
  end if;

  select * into v_recon
  from public.teller_bank_reconciliations
  where id = p_reconciliation_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Reconciliation not found in organization';
  end if;

  if v_recon.status = 'completed' then
    return jsonb_build_object(
      'reconciliation_id', v_recon.id,
      'status', v_recon.status,
      'duplicate', true
    );
  end if;

  if v_recon.status not in ('draft', 'in_progress', 'reopened') then
    raise exception 'Reconciliation status % cannot be finalized', v_recon.status;
  end if;

  v_beginning := coalesce(
    nullif(v_recon.beginning_reconciled_balance, 0),
    public.teller_bank_reconciliation_prior_ending_balance(
      p_organization_id,
      v_recon.bank_account_id,
      v_recon.statement_start_date
    )
  );

  v_cleared := public.teller_bank_reconciliation_net_cleared(v_recon.id);
  v_difference := round(
    (v_recon.statement_ending_balance - (v_beginning + v_cleared))::numeric,
    2
  );

  if abs(v_difference) > 0.01 then
    raise exception 'Reconciliation difference % exceeds tolerance (beginning %, cleared %, ending %)',
      v_difference, v_beginning, v_cleared, v_recon.statement_ending_balance;
  end if;

  update public.teller_bank_reconciliations
  set
    status = 'completed',
    beginning_reconciled_balance = v_beginning,
    completed_by = coalesce(p_actor_id, auth.uid()),
    completed_at = now(),
    updated_at = now()
  where id = v_recon.id;

  for v_txn_id in
    select distinct ri.bank_transaction_id
    from public.teller_bank_reconciliation_items ri
    where ri.reconciliation_id = v_recon.id
      and ri.bank_transaction_id is not null
  loop
    update public.teller_bank_transactions
    set
      status = 'reconciled',
      updated_at = now()
    where id = v_txn_id
      and organization_id = p_organization_id;
  end loop;

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
    'bank_reconciliation.finalized',
    'bank_reconciliation',
    v_recon.id,
    jsonb_build_object(
      'bank_account_id', v_recon.bank_account_id,
      'beginning_balance', v_beginning,
      'cleared_net', v_cleared,
      'statement_ending_balance', v_recon.statement_ending_balance,
      'difference', v_difference
    )
  );

  return jsonb_build_object(
    'reconciliation_id', v_recon.id,
    'status', 'completed',
    'beginning_balance', v_beginning,
    'cleared_net', v_cleared,
    'difference', v_difference,
    'duplicate', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Reopen bank reconciliation
-- ---------------------------------------------------------------------------

create or replace function public.teller_reopen_bank_reconciliation(
  p_organization_id uuid,
  p_reconciliation_id uuid,
  p_reason text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_recon public.teller_bank_reconciliations%rowtype;
  v_txn_id uuid;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Reopen reason is required';
  end if;

  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to reopen bank reconciliation';
  end if;

  select * into v_recon
  from public.teller_bank_reconciliations
  where id = p_reconciliation_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Reconciliation not found in organization';
  end if;

  if v_recon.status <> 'completed' then
    raise exception 'Only completed reconciliations can be reopened';
  end if;

  update public.teller_bank_reconciliations
  set
    status = 'reopened',
    reopened_by = coalesce(p_actor_id, auth.uid()),
    reopened_at = now(),
    reopen_reason = p_reason,
    updated_at = now()
  where id = v_recon.id;

  for v_txn_id in
    select distinct ri.bank_transaction_id
    from public.teller_bank_reconciliation_items ri
    where ri.reconciliation_id = v_recon.id
      and ri.bank_transaction_id is not null
  loop
    perform public.teller_recalc_bank_transaction_status(v_txn_id);
  end loop;

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
    'bank_reconciliation.reopened',
    'bank_reconciliation',
    v_recon.id,
    jsonb_build_object(
      'bank_account_id', v_recon.bank_account_id,
      'reason', p_reason
    )
  );

  return jsonb_build_object(
    'reconciliation_id', v_recon.id,
    'status', 'reopened'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant execute on function public.teller_next_expense_number(uuid) to authenticated, service_role;
grant execute on function public.teller_assert_org_postable_account(uuid, uuid) to authenticated, service_role;
grant execute on function public.teller_bank_reconciliation_prior_ending_balance(uuid, uuid, date) to authenticated, service_role;
grant execute on function public.teller_bank_reconciliation_net_cleared(uuid) to authenticated, service_role;
grant execute on function public.teller_bank_reconciliation_difference(uuid) to authenticated, service_role;
grant execute on function public.teller_categorize_bank_transaction(uuid, uuid, text, uuid, uuid, uuid, text, text, uuid) to authenticated, service_role;
grant execute on function public.teller_split_categorize_bank_transaction(uuid, uuid, jsonb, text, uuid) to authenticated, service_role;
grant execute on function public.teller_create_bank_transfer(uuid, uuid, uuid, numeric, date, text, uuid) to authenticated, service_role;
grant execute on function public.teller_finalize_bank_reconciliation(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.teller_reopen_bank_reconciliation(uuid, uuid, text, uuid) to authenticated, service_role;
