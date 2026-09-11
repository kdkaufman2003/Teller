-- Phase 15G manual patch — apply ONLY if 038 tables/policies already exist but
-- ALTER TABLE portions were never applied. Safe to re-run (IF NOT EXISTS).
-- Does not recreate tables, policies, or triggers.

alter table public.teller_tax_settings
  add column if not exists tax_penalty_expense_account_id uuid references public.teller_accounts (id) on delete set null,
  add column if not exists tax_interest_expense_account_id uuid references public.teller_accounts (id) on delete set null,
  add column if not exists tax_overpayment_account_id uuid references public.teller_accounts (id) on delete set null;

alter table public.teller_tax_transactions
  add column if not exists registration_id uuid references public.teller_tax_registrations (id) on delete set null,
  add column if not exists filing_period_id uuid references public.teller_tax_filing_periods (id) on delete set null,
  add column if not exists authority_id uuid references public.teller_tax_authorities (id) on delete set null,
  add column if not exists authority_payment_id uuid;

alter table public.teller_tax_transactions
  drop constraint if exists teller_tax_transactions_authority_payment_id_fkey;

alter table public.teller_tax_transactions
  add constraint teller_tax_transactions_authority_payment_id_fkey
  foreign key (authority_payment_id) references public.teller_tax_authority_payments (id) on delete set null;

-- Extend org guard to cover registration/period/authority_payment FKs (from 038 tail).
create or replace function public.teller_guard_tax_transaction_org()
returns trigger
language plpgsql
as $$
declare
  doc_org uuid;
  line_org uuid;
  reg_org uuid;
  period_org uuid;
begin
  if new.document_id is not null then
    select organization_id into doc_org from public.teller_documents where id = new.document_id;
    if doc_org is distinct from new.organization_id then
      raise exception 'Tax transaction document must belong to organization';
    end if;
  end if;
  if new.line_id is not null then
    select d.organization_id into line_org
    from public.teller_document_lines l
    join public.teller_documents d on d.id = l.document_id
    where l.id = new.line_id;
    if line_org is distinct from new.organization_id then
      raise exception 'Tax transaction line must belong to organization';
    end if;
  end if;
  if new.posted_journal_entry_id is not null then
    select organization_id into doc_org from public.teller_journal_entries where id = new.posted_journal_entry_id;
    if doc_org is distinct from new.organization_id then
      raise exception 'Tax transaction journal must belong to organization';
    end if;
  end if;
  if new.registration_id is not null then
    select organization_id into reg_org from public.teller_tax_registrations where id = new.registration_id;
    if reg_org is distinct from new.organization_id then
      raise exception 'Tax transaction registration must belong to organization';
    end if;
  end if;
  if new.filing_period_id is not null then
    select organization_id into period_org from public.teller_tax_filing_periods where id = new.filing_period_id;
    if period_org is distinct from new.organization_id then
      raise exception 'Tax transaction filing period must belong to organization';
    end if;
  end if;
  if new.authority_payment_id is not null then
    select organization_id into reg_org from public.teller_tax_authority_payments where id = new.authority_payment_id;
    if reg_org is distinct from new.organization_id then
      raise exception 'Tax transaction authority payment must belong to organization';
    end if;
  end if;
  return new;
end;
$$;
