-- Phase 4: Customer Deposits COA backfill, settlement reversals/refunds/write-offs

-- ---------------------------------------------------------------------------
-- Customer Deposits liability account (idempotent org backfill)
-- ---------------------------------------------------------------------------

insert into public.teller_accounts (
  organization_id,
  code,
  name,
  type,
  subtype,
  industry_tag,
  archived,
  is_system
)
select
  org.id,
  '2300',
  'Customer Deposits',
  'liability',
  'deposit',
  '',
  false,
  true
from public.teller_organizations org
where not exists (
  select 1
  from public.teller_accounts account
  where account.organization_id = org.id
    and account.type = 'liability'
    and (
      account.subtype = 'deposit'
      or account.code = '2300'
    )
);

-- ---------------------------------------------------------------------------
-- Bad Debt Expense account for write-offs (idempotent org backfill)
-- ---------------------------------------------------------------------------

insert into public.teller_accounts (
  organization_id,
  code,
  name,
  type,
  subtype,
  industry_tag,
  archived,
  is_system
)
select
  org.id,
  '6850',
  'Bad Debt Expense',
  'expense',
  'bad_debt',
  '',
  false,
  true
from public.teller_organizations org
where not exists (
  select 1
  from public.teller_accounts account
  where account.organization_id = org.id
    and account.type = 'expense'
    and (
      account.subtype = 'bad_debt'
      or account.code = '6850'
    )
);

-- ---------------------------------------------------------------------------
-- Allocation reversal columns (immutable settlement model)
-- ---------------------------------------------------------------------------

alter table public.teller_payment_allocations
  add column if not exists reversal_of_allocation_id uuid
  references public.teller_payment_allocations (id) on delete set null;

alter table public.teller_payment_allocations
  add column if not exists reversed_by_allocation_id uuid
  references public.teller_payment_allocations (id) on delete set null;

alter table public.teller_payment_allocations
  add column if not exists reversal_event_id uuid;

create index if not exists teller_payment_allocations_reversal_of_idx
  on public.teller_payment_allocations (reversal_of_allocation_id)
  where reversal_of_allocation_id is not null;

create index if not exists teller_payment_allocations_org_reversal_event_idx
  on public.teller_payment_allocations (organization_id, reversal_event_id)
  where reversal_event_id is not null;

create unique index if not exists teller_payment_allocations_org_reversal_event_source_idx
  on public.teller_payment_allocations (organization_id, reversal_event_id, reversal_of_allocation_id)
  where reversal_event_id is not null and reversal_of_allocation_id is not null;

alter table public.teller_payment_allocations
  drop constraint if exists teller_payment_allocations_kind_check;

alter table public.teller_payment_allocations
  add constraint teller_payment_allocations_kind_check
  check (allocation_kind in (
    'invoice_payment',
    'bill_payment',
    'deposit_apply',
    'credit_apply',
    'vendor_credit_apply',
    'refund_offset',
    'invoice_payment_reversal',
    'bill_payment_reversal',
    'deposit_apply_reversal'
  ));

alter table public.teller_document_allocations
  add column if not exists reversal_of_allocation_id uuid
  references public.teller_document_allocations (id) on delete set null;

alter table public.teller_document_allocations
  add column if not exists reversed_by_allocation_id uuid
  references public.teller_document_allocations (id) on delete set null;

alter table public.teller_document_allocations
  add column if not exists reversal_event_id uuid;

create unique index if not exists teller_document_allocations_org_reversal_event_idx
  on public.teller_document_allocations (organization_id, reversal_event_id)
  where reversal_event_id is not null;

alter table public.teller_document_allocations
  drop constraint if exists teller_document_allocations_kind_check;

alter table public.teller_document_allocations
  add constraint teller_document_allocations_kind_check
  check (allocation_kind in (
    'customer_credit_apply',
    'vendor_credit_apply',
    'customer_credit_apply_reversal',
    'vendor_credit_apply_reversal'
  ));

-- ---------------------------------------------------------------------------
-- Payment / write-off settlement event ids
-- ---------------------------------------------------------------------------

alter table public.teller_payments
  add column if not exists reversal_event_id uuid;

alter table public.teller_payments
  add column if not exists refund_event_id uuid;

create unique index if not exists teller_payments_org_reversal_event_idx
  on public.teller_payments (organization_id, reversal_event_id)
  where reversal_event_id is not null;

create unique index if not exists teller_payments_org_refund_event_idx
  on public.teller_payments (organization_id, refund_event_id)
  where refund_event_id is not null;

create unique index if not exists teller_journal_entries_payment_reversal_event_idx
  on public.teller_journal_entries (organization_id, source_id)
  where source_kind = 'payment-reversal' and source_id is not null;

create unique index if not exists teller_journal_entries_deposit_refund_event_idx
  on public.teller_journal_entries (organization_id, source_id)
  where source_kind = 'deposit-refund' and source_id is not null;

create unique index if not exists teller_journal_entries_customer_refund_event_idx
  on public.teller_journal_entries (organization_id, source_id)
  where source_kind = 'customer-refund' and source_id is not null;

create unique index if not exists teller_journal_entries_deposit_application_reversal_event_idx
  on public.teller_journal_entries (organization_id, source_id)
  where source_kind = 'deposit-application-reversal' and source_id is not null;

create unique index if not exists teller_journal_entries_credit_refund_event_idx
  on public.teller_journal_entries (organization_id, source_id)
  where source_kind = 'credit-refund' and source_id is not null;

create table if not exists public.teller_write_offs (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  document_id uuid not null references public.teller_documents (id) on delete cascade,
  amount numeric(14, 2) not null,
  writeoff_date date not null,
  reason text not null,
  journal_entry_id uuid not null references public.teller_journal_entries (id) on delete restrict,
  writeoff_event_id uuid not null,
  created_at timestamptz not null default now(),
  constraint teller_write_offs_amount_positive check (amount > 0),
  unique (organization_id, writeoff_event_id)
);

create index if not exists teller_write_offs_org_doc_idx
  on public.teller_write_offs (organization_id, document_id);

alter table public.teller_write_offs enable row level security;

create policy "teller members read write-offs"
  on public.teller_write_offs for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers insert write-offs"
  on public.teller_write_offs for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- Allocation immutability: authoritative sums derive from reversal EVENT rows
-- (reversal_of_allocation_id). reversed_by_allocation_id on the original row
-- is a denormalized lookup cache only — integrity checks must compare both.

create or replace function public.teller_payment_allocation_is_active(
  p_allocation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.teller_payment_allocations pa
    where pa.id = p_allocation_id
      and pa.reversal_of_allocation_id is null
      and not exists (
        select 1
        from public.teller_payment_allocations rev
        where rev.reversal_of_allocation_id = pa.id
          and rev.organization_id = pa.organization_id
      )
  );
$$;

create or replace function public.teller_document_allocation_is_active(
  p_allocation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.teller_document_allocations da
    where da.id = p_allocation_id
      and da.reversal_of_allocation_id is null
      and not exists (
        select 1
        from public.teller_document_allocations rev
        where rev.reversal_of_allocation_id = da.id
          and rev.organization_id = da.organization_id
      )
  );
$$;

-- SECURITY DEFINER RPCs must validate org ownership of every supplied account/party id.
create or replace function public.teller_assert_org_cash_account(
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
      and a.type = 'asset'
      and (
        a.subtype in ('bank', '')
        or a.code = '1000'
      )
  ) then
    raise exception 'Cash/bank account % is invalid for organization', p_account_id;
  end if;
end;
$$;

create or replace function public.teller_assert_org_deposit_liability_account(
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
      and a.type = 'liability'
      and (
        a.subtype = 'deposit'
        or a.code = '2300'
      )
  ) then
    raise exception 'Customer Deposits account % is invalid for organization', p_account_id;
  end if;
end;
$$;

create or replace function public.teller_assert_org_receivable_account(
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
      and a.type = 'asset'
      and (
        a.subtype = 'receivable'
        or a.code = '1100'
      )
  ) then
    raise exception 'Accounts Receivable account % is invalid for organization', p_account_id;
  end if;
end;
$$;

create or replace function public.teller_assert_org_bad_debt_account(
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
      and a.type = 'expense'
      and (
        a.subtype = 'bad_debt'
        or a.code = '6850'
      )
  ) then
    raise exception 'Bad debt expense account % is invalid for organization', p_account_id;
  end if;
end;
$$;

create or replace function public.teller_assert_org_party(
  p_organization_id uuid,
  p_party_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_party_id is null then
    return;
  end if;

  if not exists (
    select 1
    from public.teller_parties p
    where p.id = p_party_id
      and p.organization_id = p_organization_id
  ) then
    raise exception 'Party % does not belong to organization', p_party_id;
  end if;
end;
$$;

create or replace function public.teller_assert_org_document(
  p_organization_id uuid,
  p_document_id uuid,
  p_expected_kind text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1
    from public.teller_documents d
    where d.id = p_document_id
      and d.organization_id = p_organization_id
      and (p_expected_kind is null or d.kind = p_expected_kind)
  ) then
    raise exception 'Document % is invalid for organization', p_document_id;
  end if;
end;
$$;

create or replace function public.teller_active_payment_allocation_total(
  p_organization_id uuid,
  p_document_id uuid default null,
  p_payment_id uuid default null
)
returns numeric
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(round(sum(
    case
      when pa.allocation_kind in (
        'invoice_payment',
        'bill_payment',
        'deposit_apply',
        'credit_apply',
        'vendor_credit_apply'
      ) then pa.amount
      else 0
    end
  )::numeric, 2), 0)
  from public.teller_payment_allocations pa
  inner join public.teller_payments p on p.id = pa.payment_id
  where pa.organization_id = p_organization_id
    and pa.reversal_of_allocation_id is null
    and not exists (
      select 1
      from public.teller_payment_allocations rev
      where rev.reversal_of_allocation_id = pa.id
        and rev.organization_id = pa.organization_id
    )
    and coalesce(p.status, 'posted') = 'posted'
    and (p_document_id is null or pa.document_id = p_document_id)
    and (p_payment_id is null or pa.payment_id = p_payment_id);
$$;

create or replace function public.teller_active_document_allocation_total(
  p_organization_id uuid,
  p_target_document_id uuid default null,
  p_source_document_id uuid default null
)
returns numeric
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(round(sum(da.amount)::numeric, 2), 0)
  from public.teller_document_allocations da
  where da.organization_id = p_organization_id
    and da.reversal_of_allocation_id is null
    and not exists (
      select 1
      from public.teller_document_allocations rev
      where rev.reversal_of_allocation_id = da.id
        and rev.organization_id = da.organization_id
    )
    and da.allocation_kind in ('customer_credit_apply', 'vendor_credit_apply')
    and (p_target_document_id is null or da.target_document_id = p_target_document_id)
    and (p_source_document_id is null or da.source_document_id = p_source_document_id);
$$;

create or replace function public.teller_document_writeoff_total(
  p_organization_id uuid,
  p_document_id uuid
)
returns numeric
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(round(sum(w.amount)::numeric, 2), 0)
  from public.teller_write_offs w
  where w.organization_id = p_organization_id
    and w.document_id = p_document_id;
$$;

create or replace function public.teller_refresh_invoice_settlement(
  p_organization_id uuid,
  p_invoice_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_invoice public.teller_documents%rowtype;
  v_paid numeric(14, 2);
  v_credits numeric(14, 2);
  v_writeoffs numeric(14, 2);
  v_settled numeric(14, 2);
  v_remaining numeric(14, 2);
  v_status text;
begin
  select * into v_invoice
  from public.teller_documents
  where id = p_invoice_id
    and organization_id = p_organization_id
    and kind = 'invoice'
  for update;

  if not found then
    raise exception 'Invoice not found in organization';
  end if;

  if v_invoice.status = 'void' then
    return jsonb_build_object(
      'invoice_id', p_invoice_id,
      'amount_paid', v_invoice.amount_paid,
      'status', v_invoice.status,
      'remaining', 0
    );
  end if;

  v_paid := public.teller_active_payment_allocation_total(p_organization_id, p_invoice_id, null);
  v_credits := public.teller_active_document_allocation_total(p_organization_id, p_invoice_id, null);
  v_writeoffs := public.teller_document_writeoff_total(p_organization_id, p_invoice_id);
  v_settled := round(v_paid + v_credits + v_writeoffs, 2);
  v_remaining := round(greatest(v_invoice.total - v_settled, 0), 2);

  if v_remaining <= 0.009 then
    v_status := 'paid';
  elsif v_settled > 0.009 then
    v_status := 'partially_paid';
  else
    v_status := 'open';
  end if;

  update public.teller_documents
  set
    -- amount_paid is CASH PAYMENTS ONLY (not credits, not write-offs)
    amount_paid = v_paid,
    status = v_status,
    updated_at = now()
  where id = p_invoice_id;

  return jsonb_build_object(
    'invoice_id', p_invoice_id,
    'amount_paid', v_paid,
    'credits_applied', v_credits,
    'writeoffs', v_writeoffs,
    'status', v_status,
    'remaining', v_remaining
  );
end;
$$;

create or replace function public.teller_refresh_bill_settlement(
  p_organization_id uuid,
  p_bill_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bill public.teller_documents%rowtype;
  v_paid numeric(14, 2);
  v_credits numeric(14, 2);
  v_settled numeric(14, 2);
  v_remaining numeric(14, 2);
  v_status text;
begin
  select * into v_bill
  from public.teller_documents
  where id = p_bill_id
    and organization_id = p_organization_id
    and kind in ('bill', 'expense')
  for update;

  if not found then
    raise exception 'Bill not found in organization';
  end if;

  if v_bill.status = 'void' then
    return jsonb_build_object(
      'bill_id', p_bill_id,
      'amount_paid', v_bill.amount_paid,
      'status', v_bill.status,
      'remaining', 0
    );
  end if;

  v_paid := public.teller_active_payment_allocation_total(p_organization_id, p_bill_id, null);
  v_credits := public.teller_active_document_allocation_total(p_organization_id, p_bill_id, null);
  v_settled := round(v_paid + v_credits, 2);
  v_remaining := round(greatest(v_bill.total - v_settled, 0), 2);

  if v_remaining <= 0.009 then
    v_status := 'paid';
  elsif v_settled > 0.009 then
    v_status := 'partially_paid';
  else
    v_status := 'open';
  end if;

  update public.teller_documents
  set
    amount_paid = v_paid,
    status = v_status,
    updated_at = now()
  where id = p_bill_id;

  return jsonb_build_object(
    'bill_id', p_bill_id,
    'amount_paid', v_paid,
    'credits_applied', v_credits,
    'status', v_status,
    'remaining', v_remaining
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Reverse customer or bill payment (FULL reversal only — void payment + reverse journal + ALL allocations)
-- Partial payment reversal is intentionally unsupported; use credit memo + credit refund for economic refunds.
-- Supports one payment allocated across multiple documents.
-- ---------------------------------------------------------------------------

create or replace function public.teller_reverse_payment(
  p_organization_id uuid,
  p_payment_id uuid,
  p_reversal_date date,
  p_reversal_event_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_payment public.teller_payments%rowtype;
  v_closed_through date;
  v_reversal_entry_id uuid;
  v_lines jsonb := '[]'::jsonb;
  v_line record;
  v_alloc record;
  v_reversal_alloc_id uuid;
  v_reversal_kind text;
  v_doc_id uuid;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Reversal reason is required.';
  end if;

  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to reverse payment';
  end if;

  select * into v_payment
  from public.teller_payments
  where id = p_payment_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Payment not found in organization';
  end if;

  if v_payment.reversal_event_id = p_reversal_event_id then
    return jsonb_build_object(
      'payment_id', v_payment.id,
      'reversal_entry_id', v_payment.void_journal_entry_id,
      'duplicate', true
    );
  end if;

  if v_payment.reversal_event_id is not null then
    raise exception 'Payment has already been reversed under a different event.';
  end if;

  if coalesce(v_payment.status, 'posted') <> 'posted' then
    raise exception 'Only posted payments can be reversed.';
  end if;

  if v_payment.payment_type not in ('customer_payment', 'bill_payment') then
    raise exception 'Payment type cannot be reversed through this workflow.';
  end if;

  if v_payment.journal_entry_id is null then
    raise exception 'Payment is missing a journal entry.';
  end if;

  v_closed_through := public.teller_books_closed_through(p_organization_id);
  if v_closed_through is not null and p_reversal_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  if exists (
    select 1
    from public.teller_journal_entries
    where reverses_entry_id = v_payment.journal_entry_id
      and organization_id = p_organization_id
  ) then
    raise exception 'Payment journal has already been reversed.';
  end if;

  -- Lock every affected document in deterministic order before reversing allocations.
  for v_doc_id in
    select distinct doc_id
    from (
      select pa.document_id as doc_id
      from public.teller_payment_allocations pa
      where pa.payment_id = v_payment.id
        and pa.organization_id = p_organization_id
        and pa.allocation_kind in ('invoice_payment', 'bill_payment')
        and pa.reversal_of_allocation_id is null
        and not exists (
          select 1
          from public.teller_payment_allocations rev
          where rev.reversal_of_allocation_id = pa.id
            and rev.organization_id = pa.organization_id
        )
      union
      select v_payment.document_id
      where v_payment.document_id is not null
    ) docs
    where doc_id is not null
    order by doc_id
  loop
    perform 1
    from public.teller_documents
    where id = v_doc_id
      and organization_id = p_organization_id
    for update;
  end loop;

  for v_line in
    select account_id, debit, credit, party_id, job_id, memo
    from public.teller_journal_lines
    where entry_id = v_payment.journal_entry_id
  loop
    v_lines := v_lines || jsonb_build_object(
      'account_id', v_line.account_id,
      'debit', round(coalesce(v_line.credit, 0)::numeric, 2),
      'credit', round(coalesce(v_line.debit, 0)::numeric, 2),
      'party_id', v_line.party_id,
      'job_id', v_line.job_id,
      'memo', coalesce('Reversal: ' || v_line.memo, 'Payment reversal')
    );
  end loop;

  v_reversal_entry_id := public.teller_post_journal(
    p_organization_id,
    p_reversal_date,
    coalesce(p_reason, 'Payment reversal'),
    'payment-reversal',
    p_reversal_event_id,
    v_payment.journal_entry_id,
    v_lines
  );

  update public.teller_payments
  set
    status = 'void',
    voided_at = now(),
    void_reason = p_reason,
    void_journal_entry_id = v_reversal_entry_id,
    reversal_event_id = p_reversal_event_id
  where id = v_payment.id;

  v_reversal_kind := case
    when v_payment.payment_type = 'customer_payment' then 'invoice_payment_reversal'
    else 'bill_payment_reversal'
  end;

  for v_alloc in
    select id, document_id, amount, allocation_kind
    from public.teller_payment_allocations
    where payment_id = v_payment.id
      and organization_id = p_organization_id
      and allocation_kind in ('invoice_payment', 'bill_payment')
      and reversal_of_allocation_id is null
      and not exists (
        select 1
        from public.teller_payment_allocations rev
        where rev.reversal_of_allocation_id = teller_payment_allocations.id
          and rev.organization_id = teller_payment_allocations.organization_id
      )
  loop
    insert into public.teller_payment_allocations (
      organization_id,
      payment_id,
      document_id,
      amount,
      allocation_kind,
      reversal_of_allocation_id,
      reversal_event_id
    )
    values (
      p_organization_id,
      v_payment.id,
      v_alloc.document_id,
      v_alloc.amount,
      v_reversal_kind,
      v_alloc.id,
      p_reversal_event_id
    )
    returning id into v_reversal_alloc_id;

    update public.teller_payment_allocations
    set reversed_by_allocation_id = v_reversal_alloc_id
    where id = v_alloc.id;
  end loop;

  for v_doc_id in
    select distinct doc_id
    from (
      select pa.document_id as doc_id
      from public.teller_payment_allocations pa
      where pa.payment_id = v_payment.id
        and pa.organization_id = p_organization_id
        and pa.allocation_kind in ('invoice_payment', 'bill_payment')
        and pa.reversal_of_allocation_id is null
      union
      select v_payment.document_id
      where v_payment.document_id is not null
    ) docs
    where doc_id is not null
    order by doc_id
  loop
    if v_payment.payment_type = 'customer_payment' then
      perform public.teller_refresh_invoice_settlement(p_organization_id, v_doc_id);
    else
      perform public.teller_refresh_bill_settlement(p_organization_id, v_doc_id);
    end if;
  end loop;

  if v_payment.document_id is not null then
    insert into public.teller_document_journal_links (
      organization_id,
      document_id,
      journal_entry_id,
      link_kind,
      payment_id
    )
    values (
      p_organization_id,
      v_payment.document_id,
      v_reversal_entry_id,
      'reversal',
      v_payment.id
    )
    on conflict (document_id, journal_entry_id) do nothing;
  end if;

  return jsonb_build_object(
    'payment_id', v_payment.id,
    'reversal_entry_id', v_reversal_entry_id,
    'duplicate', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Reverse deposit application (Dr AR, Cr Customer Deposits)
-- ---------------------------------------------------------------------------

create or replace function public.teller_reverse_deposit_application(
  p_organization_id uuid,
  p_allocation_id uuid,
  p_reversal_date date,
  p_reversal_event_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_alloc public.teller_payment_allocations%rowtype;
  v_payment public.teller_payments%rowtype;
  v_invoice public.teller_documents%rowtype;
  v_closed_through date;
  v_reversal_entry_id uuid;
  v_reversal_alloc_id uuid;
  v_deposits_account uuid;
  v_ar_account uuid;
  v_lines jsonb;
  v_settlement jsonb;
  v_applied numeric(14, 2);
  v_refunded numeric(14, 2);
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Reversal reason is required.';
  end if;

  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to reverse deposit application';
  end if;

  select * into v_alloc
  from public.teller_payment_allocations
  where id = p_allocation_id
    and organization_id = p_organization_id
    and allocation_kind = 'deposit_apply'
  for update;

  if not found then
    raise exception 'Deposit application not found';
  end if;

  -- Idempotency: reversal event id lives on the immutable reversal row, not the original.
  select rev.id, rev.application_journal_entry_id
  into v_reversal_alloc_id, v_reversal_entry_id
  from public.teller_payment_allocations rev
  where rev.organization_id = p_organization_id
    and rev.reversal_of_allocation_id = v_alloc.id
    and rev.reversal_event_id = p_reversal_event_id
  limit 1;

  if found then
    select * into v_payment
    from public.teller_payments
    where id = v_alloc.payment_id
      and organization_id = p_organization_id;

    v_applied := public.teller_active_payment_allocation_total(
      p_organization_id,
      null,
      v_payment.id
    );

    select coalesce(round(sum(amount)::numeric, 2), 0)
    into v_refunded
    from public.teller_payments
    where organization_id = p_organization_id
      and payment_type = 'customer_refund'
      and coalesce(status, 'posted') = 'posted'
      and metadata ->> 'source_deposit_payment_id' = v_payment.id::text;

    return jsonb_build_object(
      'allocation_id', v_alloc.id,
      'reversal_allocation_id', v_reversal_alloc_id,
      'reversal_entry_id', v_reversal_entry_id,
      'deposit_remaining', round(v_payment.amount - v_applied - v_refunded, 2),
      'duplicate', true
    );
  end if;

  if v_alloc.reversed_by_allocation_id is not null
     or exists (
       select 1
       from public.teller_payment_allocations rev
       where rev.reversal_of_allocation_id = v_alloc.id
         and rev.organization_id = v_alloc.organization_id
     ) then
    raise exception 'Deposit application has already been reversed.';
  end if;

  select * into v_payment
  from public.teller_payments
  where id = v_alloc.payment_id
    and organization_id = p_organization_id
  for update;

  select * into v_invoice
  from public.teller_documents
  where id = v_alloc.document_id
    and organization_id = p_organization_id
  for update;

  v_closed_through := public.teller_books_closed_through(p_organization_id);
  if v_closed_through is not null and p_reversal_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  if v_alloc.application_journal_entry_id is not null and exists (
    select 1 from public.teller_journal_entries
    where reverses_entry_id = v_alloc.application_journal_entry_id
      and organization_id = p_organization_id
  ) then
    raise exception 'Deposit application journal has already been reversed.';
  end if;

  select id into v_deposits_account
  from public.teller_accounts
  where organization_id = p_organization_id
    and (subtype = 'deposit' or code = '2300')
  order by case when subtype = 'deposit' then 0 else 1 end
  limit 1;

  select id into v_ar_account
  from public.teller_accounts
  where organization_id = p_organization_id
    and (subtype = 'receivable' or code = '1100')
  order by case when subtype = 'receivable' then 0 else 1 end
  limit 1;

  if v_deposits_account is null or v_ar_account is null then
    raise exception 'Customer Deposits or AR account is missing';
  end if;

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', v_ar_account,
      'debit', v_alloc.amount,
      'credit', 0,
      'party_id', v_payment.party_id,
      'job_id', v_payment.job_id,
      'memo', 'Reverse deposit application'
    ),
    jsonb_build_object(
      'account_id', v_deposits_account,
      'debit', 0,
      'credit', v_alloc.amount,
      'party_id', v_payment.party_id,
      'job_id', v_payment.job_id,
      'memo', 'Restore unapplied deposit'
    )
  );

  v_reversal_entry_id := public.teller_post_journal(
    p_organization_id,
    p_reversal_date,
    coalesce(p_reason, 'Reverse deposit application'),
    'deposit-application-reversal',
    p_reversal_event_id,
    v_alloc.application_journal_entry_id,
    v_lines
  );

  insert into public.teller_payment_allocations (
    organization_id,
    payment_id,
    document_id,
    amount,
    allocation_kind,
    reversal_of_allocation_id,
    reversal_event_id,
    application_journal_entry_id
  )
  values (
    p_organization_id,
    v_alloc.payment_id,
    v_alloc.document_id,
    v_alloc.amount,
    'deposit_apply_reversal',
    v_alloc.id,
    p_reversal_event_id,
    v_reversal_entry_id
  )
  returning id into v_reversal_alloc_id;

  update public.teller_payment_allocations
  set reversed_by_allocation_id = v_reversal_alloc_id
  where id = v_alloc.id;

  insert into public.teller_document_journal_links (
    organization_id,
    document_id,
    journal_entry_id,
    link_kind,
    payment_id
  )
  values (
    p_organization_id,
    v_alloc.document_id,
    v_reversal_entry_id,
    'reversal',
    v_payment.id
  )
  on conflict (document_id, journal_entry_id) do nothing;

  v_settlement := public.teller_refresh_invoice_settlement(p_organization_id, v_alloc.document_id);

  v_applied := public.teller_active_payment_allocation_total(
    p_organization_id,
    null,
    v_payment.id
  );

  select coalesce(round(sum(amount)::numeric, 2), 0)
  into v_refunded
  from public.teller_payments
  where organization_id = p_organization_id
    and payment_type = 'customer_refund'
    and coalesce(status, 'posted') = 'posted'
    and metadata ->> 'source_deposit_payment_id' = v_payment.id::text;

  return jsonb_build_object(
    'allocation_id', v_alloc.id,
    'reversal_allocation_id', v_reversal_alloc_id,
    'reversal_entry_id', v_reversal_entry_id,
    'deposit_remaining', round(v_payment.amount - v_applied - v_refunded, 2),
    'invoice', v_settlement,
    'duplicate', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Reverse credit application (allocation only — no credit memo journal reversal)
-- ---------------------------------------------------------------------------

create or replace function public.teller_reverse_document_allocation(
  p_organization_id uuid,
  p_allocation_id uuid,
  p_reversal_event_id uuid,
  p_reason text,
  p_reversal_date date default current_date
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_alloc public.teller_document_allocations%rowtype;
  v_reversal_alloc_id uuid;
  v_reversal_kind text;
  v_target_kind text;
  v_closed_through date;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Reversal reason is required.';
  end if;

  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to reverse credit application';
  end if;

  v_closed_through := public.teller_books_closed_through(p_organization_id);
  if v_closed_through is not null and p_reversal_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  select * into v_alloc
  from public.teller_document_allocations
  where id = p_allocation_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Credit application not found';
  end if;

  -- Idempotency: reversal event id lives on the immutable reversal row, not the original.
  select rev.id into v_reversal_alloc_id
  from public.teller_document_allocations rev
  where rev.organization_id = p_organization_id
    and rev.reversal_of_allocation_id = v_alloc.id
    and rev.reversal_event_id = p_reversal_event_id
  limit 1;

  if found then
    return jsonb_build_object(
      'allocation_id', v_alloc.id,
      'reversal_allocation_id', v_reversal_alloc_id,
      'duplicate', true
    );
  end if;

  if v_alloc.reversed_by_allocation_id is not null
     or exists (
       select 1
       from public.teller_document_allocations rev
       where rev.reversal_of_allocation_id = v_alloc.id
         and rev.organization_id = v_alloc.organization_id
     ) then
    raise exception 'Credit application has already been reversed.';
  end if;

  perform public.teller_assert_org_document(p_organization_id, v_alloc.source_document_id, null);
  perform public.teller_assert_org_document(p_organization_id, v_alloc.target_document_id, null);

  perform 1
  from public.teller_documents
  where id = v_alloc.source_document_id
    and organization_id = p_organization_id
  for update;

  perform 1
  from public.teller_documents
  where id = v_alloc.target_document_id
    and organization_id = p_organization_id
  for update;

  v_reversal_kind := case v_alloc.allocation_kind
    when 'customer_credit_apply' then 'customer_credit_apply_reversal'
    else 'vendor_credit_apply_reversal'
  end;

  insert into public.teller_document_allocations (
    organization_id,
    source_document_id,
    target_document_id,
    amount,
    allocation_kind,
    reversal_of_allocation_id,
    reversal_event_id
  )
  values (
    p_organization_id,
    v_alloc.source_document_id,
    v_alloc.target_document_id,
    v_alloc.amount,
    v_reversal_kind,
    v_alloc.id,
    p_reversal_event_id
  )
  returning id into v_reversal_alloc_id;

  update public.teller_document_allocations
  set reversed_by_allocation_id = v_reversal_alloc_id
  where id = v_alloc.id;

  select kind into v_target_kind
  from public.teller_documents
  where id = v_alloc.target_document_id;

  if v_target_kind = 'invoice' then
    perform public.teller_refresh_invoice_settlement(p_organization_id, v_alloc.target_document_id);
  elsif v_target_kind in ('bill', 'expense') then
    perform public.teller_refresh_bill_settlement(p_organization_id, v_alloc.target_document_id);
  end if;

  return jsonb_build_object(
    'allocation_id', v_alloc.id,
    'reversal_allocation_id', v_reversal_alloc_id,
    'duplicate', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Refund unapplied customer deposit (Dr Customer Deposits, Cr Cash)
-- ---------------------------------------------------------------------------

create or replace function public.teller_refund_customer_deposit(
  p_organization_id uuid,
  p_deposit_payment_id uuid,
  p_amount numeric,
  p_refund_date date,
  p_refund_event_id uuid,
  p_reason text,
  p_cash_account_id uuid,
  p_deposits_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_deposit public.teller_payments%rowtype;
  v_refund public.teller_payments%rowtype;
  v_applied numeric(14, 2);
  v_refunded numeric(14, 2);
  v_unapplied numeric(14, 2);
  v_amount numeric(14, 2);
  v_entry_id uuid;
  v_lines jsonb;
  v_closed_through date;
begin
  v_amount := round(p_amount::numeric, 2);

  if v_amount <= 0 then
    raise exception 'Refund amount must be greater than zero.';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Refund reason is required.';
  end if;

  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to refund deposit';
  end if;

  select * into v_refund
  from public.teller_payments
  where organization_id = p_organization_id
    and refund_event_id = p_refund_event_id
    and payment_type = 'customer_refund';

  if found then
    if round(v_refund.amount, 2) <> v_amount then
      raise exception 'Idempotency conflict: refund event is tied to a different amount.';
    end if;
    if coalesce(v_refund.metadata ->> 'source_deposit_payment_id', '') <> p_deposit_payment_id::text then
      raise exception 'Idempotency conflict: refund event is tied to a different deposit.';
    end if;

    return jsonb_build_object(
      'refund_payment_id', v_refund.id,
      'journal_entry_id', v_refund.journal_entry_id,
      'duplicate', true
    );
  end if;

  select * into v_deposit
  from public.teller_payments
  where id = p_deposit_payment_id
    and organization_id = p_organization_id
    and payment_type = 'customer_deposit'
  for update;

  if not found then
    raise exception 'Customer deposit not found';
  end if;

  if coalesce(v_deposit.status, 'posted') <> 'posted' then
    raise exception 'Only posted deposits can be refunded.';
  end if;

  perform public.teller_assert_org_cash_account(p_organization_id, p_cash_account_id);
  perform public.teller_assert_org_deposit_liability_account(p_organization_id, p_deposits_account_id);
  perform public.teller_assert_org_party(p_organization_id, v_deposit.party_id);

  v_closed_through := public.teller_books_closed_through(p_organization_id);
  if v_closed_through is not null and p_refund_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  v_applied := public.teller_active_payment_allocation_total(p_organization_id, null, v_deposit.id);

  select coalesce(round(sum(amount)::numeric, 2), 0) into v_refunded
  from public.teller_payments
  where organization_id = p_organization_id
    and payment_type = 'customer_refund'
    and coalesce(status, 'posted') = 'posted'
    and metadata ->> 'source_deposit_payment_id' = v_deposit.id::text;

  v_unapplied := round(v_deposit.amount - v_applied - v_refunded, 2);

  if v_amount > v_unapplied + 0.009 then
    raise exception 'Refund amount exceeds unapplied deposit balance.';
  end if;

  if p_reason = '__TELLER_INTEGRATION_FORCE_ROLLBACK__' then
    raise exception 'TELLER_INTEGRATION_FORCE_ROLLBACK';
  end if;

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', p_deposits_account_id,
      'debit', v_amount,
      'credit', 0,
      'party_id', v_deposit.party_id,
      'job_id', v_deposit.job_id,
      'memo', 'Customer deposit refund'
    ),
    jsonb_build_object(
      'account_id', p_cash_account_id,
      'debit', 0,
      'credit', v_amount,
      'party_id', v_deposit.party_id,
      'job_id', v_deposit.job_id,
      'memo', 'Customer deposit refund'
    )
  );

  v_entry_id := public.teller_post_journal(
    p_organization_id,
    p_refund_date,
    coalesce(p_reason, 'Customer deposit refund'),
    'deposit-refund',
    p_refund_event_id,
    null,
    v_lines
  );

  insert into public.teller_payments (
    organization_id,
    document_id,
    party_id,
    job_id,
    amount,
    fee_amount,
    net_amount,
    payment_date,
    journal_entry_id,
    payment_type,
    status,
    refund_event_id,
    metadata
  )
  values (
    p_organization_id,
    null,
    v_deposit.party_id,
    v_deposit.job_id,
    v_amount,
    0,
    v_amount,
    p_refund_date,
    v_entry_id,
    'customer_refund',
    'posted',
    p_refund_event_id,
    jsonb_build_object(
      'source_deposit_payment_id', v_deposit.id,
      'reason', p_reason,
      'kind', 'deposit_refund'
    )
  )
  returning * into v_refund;

  return jsonb_build_object(
    'refund_payment_id', v_refund.id,
    'journal_entry_id', v_entry_id,
    'deposit_unapplied_remaining', round(v_unapplied - v_amount, 2),
    'duplicate', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Sale-related customer refunds MUST NOT bypass credit memos.
-- Economic refunds of reduced sale value use:
--   1. credit memo (Dr revenue/contra, Cr AR) creating available customer credit
--   2. teller_refund_customer_credit (Dr AR, Cr Cash) against unapplied credit
-- teller_refund_customer_payment was removed because Dr AR / Cr Cash + refund_offset
-- on an invoice manufactured artificial receivable without offsetting credit.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Refund unapplied customer credit (Dr AR, Cr Cash)
-- ---------------------------------------------------------------------------

create or replace function public.teller_refund_customer_credit(
  p_organization_id uuid,
  p_credit_memo_id uuid,
  p_amount numeric,
  p_refund_date date,
  p_refund_event_id uuid,
  p_reason text,
  p_cash_account_id uuid,
  p_ar_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_credit public.teller_documents%rowtype;
  v_refund public.teller_payments%rowtype;
  v_applied numeric(14, 2);
  v_refunded numeric(14, 2);
  v_unapplied numeric(14, 2);
  v_amount numeric(14, 2);
  v_entry_id uuid;
  v_lines jsonb;
  v_closed_through date;
  v_status text;
begin
  v_amount := round(p_amount::numeric, 2);

  if v_amount <= 0 then
    raise exception 'Refund amount must be greater than zero.';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Refund reason is required.';
  end if;

  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to refund customer credit';
  end if;

  select * into v_refund
  from public.teller_payments
  where organization_id = p_organization_id
    and refund_event_id = p_refund_event_id
    and payment_type = 'customer_refund';

  if found then
    if round(v_refund.amount, 2) <> v_amount then
      raise exception 'Idempotency conflict: refund event is tied to a different amount.';
    end if;
    if v_refund.document_id is distinct from p_credit_memo_id then
      raise exception 'Idempotency conflict: refund event is tied to a different credit memo.';
    end if;

    return jsonb_build_object(
      'refund_payment_id', v_refund.id,
      'journal_entry_id', v_refund.journal_entry_id,
      'duplicate', true
    );
  end if;

  select * into v_credit
  from public.teller_documents
  where id = p_credit_memo_id
    and organization_id = p_organization_id
    and kind = 'credit_memo'
  for update;

  if not found then
    raise exception 'Credit memo not found';
  end if;

  if v_credit.status = 'void' or v_credit.status = 'draft' then
    raise exception 'Only posted credit memos can be refunded.';
  end if;

  perform public.teller_assert_org_cash_account(p_organization_id, p_cash_account_id);
  perform public.teller_assert_org_receivable_account(p_organization_id, p_ar_account_id);
  perform public.teller_assert_org_party(p_organization_id, v_credit.party_id);

  v_closed_through := public.teller_books_closed_through(p_organization_id);
  if v_closed_through is not null and p_refund_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  v_applied := public.teller_active_document_allocation_total(
    p_organization_id,
    null,
    p_credit_memo_id
  );

  select coalesce(round(sum(amount)::numeric, 2), 0) into v_refunded
  from public.teller_payments
  where organization_id = p_organization_id
    and document_id = p_credit_memo_id
    and payment_type = 'customer_refund'
    and coalesce(status, 'posted') = 'posted'
    and metadata ->> 'kind' = 'customer_credit_refund';

  v_unapplied := round(v_credit.total - v_applied - v_refunded, 2);

  if v_amount > v_unapplied + 0.009 then
    raise exception 'Refund amount exceeds unapplied credit balance.';
  end if;

  if p_reason = '__TELLER_INTEGRATION_FORCE_ROLLBACK__' then
    raise exception 'TELLER_INTEGRATION_FORCE_ROLLBACK';
  end if;

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', p_ar_account_id,
      'debit', v_amount,
      'credit', 0,
      'party_id', v_credit.party_id,
      'job_id', v_credit.job_id,
      'memo', 'Customer credit refund'
    ),
    jsonb_build_object(
      'account_id', p_cash_account_id,
      'debit', 0,
      'credit', v_amount,
      'party_id', v_credit.party_id,
      'job_id', v_credit.job_id,
      'memo', 'Customer credit refund'
    )
  );

  v_entry_id := public.teller_post_journal(
    p_organization_id,
    p_refund_date,
    coalesce(p_reason, 'Customer credit refund'),
    'credit-refund',
    p_refund_event_id,
    null,
    v_lines
  );

  insert into public.teller_payments (
    organization_id,
    document_id,
    party_id,
    job_id,
    amount,
    fee_amount,
    net_amount,
    payment_date,
    journal_entry_id,
    payment_type,
    status,
    refund_event_id,
    metadata
  )
  values (
    p_organization_id,
    p_credit_memo_id,
    v_credit.party_id,
    v_credit.job_id,
    v_amount,
    0,
    v_amount,
    p_refund_date,
    v_entry_id,
    'customer_refund',
    'posted',
    p_refund_event_id,
    jsonb_build_object('reason', p_reason, 'kind', 'customer_credit_refund')
  )
  returning * into v_refund;

  v_refunded := round(v_refunded + v_amount, 2);
  v_status := case
    when round(v_applied + v_refunded, 2) >= v_credit.total - 0.009 then 'applied'
    when v_applied > 0.009 or v_refunded > 0.009 then 'partially_applied'
    else 'open'
  end;

  update public.teller_documents
  set status = v_status,
      updated_at = now()
  where id = p_credit_memo_id;

  insert into public.teller_document_journal_links (
    organization_id,
    document_id,
    journal_entry_id,
    link_kind,
    payment_id
  )
  values (
    p_organization_id,
    p_credit_memo_id,
    v_entry_id,
    'refund',
    v_refund.id
  )
  on conflict (document_id, journal_entry_id) do nothing;

  return jsonb_build_object(
    'refund_payment_id', v_refund.id,
    'journal_entry_id', v_entry_id,
    'credit_unapplied_remaining', round(v_unapplied - v_amount, 2),
    'duplicate', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Invoice write-off (Dr Bad Debt Expense, Cr AR)
-- ---------------------------------------------------------------------------

create or replace function public.teller_write_off_invoice(
  p_organization_id uuid,
  p_invoice_id uuid,
  p_amount numeric,
  p_writeoff_date date,
  p_writeoff_event_id uuid,
  p_reason text,
  p_bad_debt_account_id uuid,
  p_ar_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_invoice public.teller_documents%rowtype;
  v_existing public.teller_write_offs%rowtype;
  v_amount numeric(14, 2);
  v_paid numeric(14, 2);
  v_credits numeric(14, 2);
  v_writeoffs numeric(14, 2);
  v_remaining numeric(14, 2);
  v_entry_id uuid;
  v_lines jsonb;
  v_closed_through date;
  v_settlement jsonb;
begin
  v_amount := round(p_amount::numeric, 2);

  if v_amount <= 0 then
    raise exception 'Write-off amount must be greater than zero.';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Write-off reason is required.';
  end if;

  if auth.uid() is not null
     and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to write off invoice balance';
  end if;

  select * into v_existing
  from public.teller_write_offs
  where organization_id = p_organization_id
    and writeoff_event_id = p_writeoff_event_id;

  if found then
    if round(v_existing.amount, 2) <> v_amount then
      raise exception 'Idempotency conflict: write-off event is tied to a different amount.';
    end if;
    if v_existing.document_id is distinct from p_invoice_id then
      raise exception 'Idempotency conflict: write-off event is tied to a different invoice.';
    end if;

    return jsonb_build_object(
      'writeoff_id', v_existing.id,
      'journal_entry_id', v_existing.journal_entry_id,
      'duplicate', true
    );
  end if;

  select * into v_invoice
  from public.teller_documents
  where id = p_invoice_id
    and organization_id = p_organization_id
    and kind = 'invoice'
  for update;

  if not found then
    raise exception 'Invoice not found';
  end if;

  if v_invoice.status = 'void' then
    raise exception 'Cannot write off a void invoice.';
  end if;

  v_closed_through := public.teller_books_closed_through(p_organization_id);
  if v_closed_through is not null and p_writeoff_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  perform public.teller_assert_org_bad_debt_account(p_organization_id, p_bad_debt_account_id);
  perform public.teller_assert_org_receivable_account(p_organization_id, p_ar_account_id);
  perform public.teller_assert_org_party(p_organization_id, v_invoice.party_id);

  v_paid := public.teller_active_payment_allocation_total(p_organization_id, p_invoice_id, null);
  v_credits := public.teller_active_document_allocation_total(p_organization_id, p_invoice_id, null);
  v_writeoffs := public.teller_document_writeoff_total(p_organization_id, p_invoice_id);
  v_remaining := round(greatest(v_invoice.total - v_paid - v_credits - v_writeoffs, 0), 2);

  if v_amount > v_remaining + 0.009 then
    raise exception 'Write-off amount exceeds remaining invoice balance.';
  end if;

  if p_reason = '__TELLER_INTEGRATION_FORCE_ROLLBACK__' then
    raise exception 'TELLER_INTEGRATION_FORCE_ROLLBACK';
  end if;

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', p_bad_debt_account_id,
      'debit', v_amount,
      'credit', 0,
      'party_id', v_invoice.party_id,
      'job_id', v_invoice.job_id,
      'memo', 'Bad debt write-off'
    ),
    jsonb_build_object(
      'account_id', p_ar_account_id,
      'debit', 0,
      'credit', v_amount,
      'party_id', v_invoice.party_id,
      'job_id', v_invoice.job_id,
      'memo', 'Write off accounts receivable'
    )
  );

  v_entry_id := public.teller_post_journal(
    p_organization_id,
    p_writeoff_date,
    coalesce(p_reason, 'Invoice write-off'),
    'invoice-writeoff',
    p_writeoff_event_id,
    null,
    v_lines
  );

  insert into public.teller_write_offs (
    organization_id,
    document_id,
    amount,
    writeoff_date,
    reason,
    journal_entry_id,
    writeoff_event_id
  )
  values (
    p_organization_id,
    p_invoice_id,
    v_amount,
    p_writeoff_date,
    p_reason,
    v_entry_id,
    p_writeoff_event_id
  )
  returning * into v_existing;

  insert into public.teller_document_journal_links (
    organization_id,
    document_id,
    journal_entry_id,
    link_kind
  )
  values (
    p_organization_id,
    p_invoice_id,
    v_entry_id,
    'writeoff'
  )
  on conflict (document_id, journal_entry_id) do nothing;

  v_settlement := public.teller_refresh_invoice_settlement(p_organization_id, p_invoice_id);

  return jsonb_build_object(
    'writeoff_id', v_existing.id,
    'journal_entry_id', v_entry_id,
    'invoice', v_settlement,
    'duplicate', false
  );
end;
$$;

grant execute on function public.teller_assert_org_cash_account(uuid, uuid) to authenticated, service_role;
grant execute on function public.teller_assert_org_deposit_liability_account(uuid, uuid) to authenticated, service_role;
grant execute on function public.teller_assert_org_receivable_account(uuid, uuid) to authenticated, service_role;
grant execute on function public.teller_assert_org_bad_debt_account(uuid, uuid) to authenticated, service_role;
grant execute on function public.teller_assert_org_party(uuid, uuid) to authenticated, service_role;
grant execute on function public.teller_assert_org_document(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.teller_payment_allocation_is_active(uuid) to authenticated, service_role;
grant execute on function public.teller_document_allocation_is_active(uuid) to authenticated, service_role;
grant execute on function public.teller_active_payment_allocation_total(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.teller_active_document_allocation_total(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.teller_document_writeoff_total(uuid, uuid) to authenticated, service_role;
grant execute on function public.teller_refresh_invoice_settlement(uuid, uuid) to authenticated, service_role;
grant execute on function public.teller_refresh_bill_settlement(uuid, uuid) to authenticated, service_role;
grant execute on function public.teller_reverse_payment(uuid, uuid, date, uuid, text) to authenticated, service_role;
grant execute on function public.teller_reverse_deposit_application(uuid, uuid, date, uuid, text) to authenticated, service_role;
grant execute on function public.teller_reverse_document_allocation(uuid, uuid, uuid, text, date) to authenticated, service_role;
grant execute on function public.teller_refund_customer_deposit(uuid, uuid, numeric, date, uuid, text, uuid, uuid) to authenticated, service_role;
grant execute on function public.teller_refund_customer_credit(uuid, uuid, numeric, date, uuid, text, uuid, uuid) to authenticated, service_role;
grant execute on function public.teller_write_off_invoice(uuid, uuid, numeric, date, uuid, text, uuid, uuid) to authenticated, service_role;
