-- Teller: industry-tailored books
-- Tables are prefixed teller_ so this can live in the same Supabase project as Quoter.

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Organizations & membership
-- ---------------------------------------------------------------------------

create table if not exists public.teller_organizations (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  legal_name text not null default '',
  industry_id text not null,
  setup_completed_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.teller_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  organization_id uuid references public.teller_organizations (id) on delete cascade,
  email text not null default '',
  full_name text not null default '',
  role text not null default 'owner' check (role in ('owner', 'admin', 'bookkeeper', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists teller_profiles_org_idx
  on public.teller_profiles (organization_id);

create table if not exists public.teller_industry_settings (
  organization_id uuid primary key references public.teller_organizations (id) on delete cascade,
  answers jsonb not null default '{}'::jsonb,
  modules text[] not null default '{}',
  labels jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Chart of accounts, parties, jobs, documents, ledger
-- ---------------------------------------------------------------------------

create table if not exists public.teller_accounts (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  code text not null,
  name text not null,
  type text not null check (type in ('asset', 'liability', 'equity', 'revenue', 'cogs', 'expense')),
  subtype text not null default '',
  industry_tag text not null default '',
  is_system boolean not null default false,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (organization_id, code)
);

create index if not exists teller_accounts_org_idx
  on public.teller_accounts (organization_id, code);

create table if not exists public.teller_parties (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  kind text not null default 'customer' check (kind in ('customer', 'vendor', 'both')),
  name text not null,
  email text not null default '',
  phone text not null default '',
  notes text not null default '',
  external_source text,
  external_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists teller_parties_external_idx
  on public.teller_parties (organization_id, external_source, external_id)
  where external_source is not null and external_id is not null;

create index if not exists teller_parties_org_kind_idx
  on public.teller_parties (organization_id, kind, name);

create table if not exists public.teller_jobs (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  job_number text not null,
  name text not null,
  party_id uuid references public.teller_parties (id) on delete set null,
  status text not null default 'estimate'
    check (status in ('estimate', 'scheduled', 'in_progress', 'complete', 'invoiced', 'cancelled')),
  job_type text not null default 'install'
    check (job_type in ('install', 'service', 'maintenance', 'warranty', 'other')),
  quoted_amount numeric(14, 2) not null default 0,
  address text not null default '',
  external_source text,
  external_id text,
  started_at date,
  completed_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, job_number)
);

create unique index if not exists teller_jobs_external_idx
  on public.teller_jobs (organization_id, external_source, external_id)
  where external_source is not null and external_id is not null;

create index if not exists teller_jobs_org_idx
  on public.teller_jobs (organization_id, status, updated_at desc);

create table if not exists public.teller_documents (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  kind text not null check (kind in ('invoice', 'bill', 'expense')),
  number text not null,
  party_id uuid references public.teller_parties (id) on delete set null,
  job_id uuid references public.teller_jobs (id) on delete set null,
  status text not null default 'draft'
    check (status in ('draft', 'open', 'paid', 'void')),
  issue_date date not null default current_date,
  due_date date,
  subtotal numeric(14, 2) not null default 0,
  tax numeric(14, 2) not null default 0,
  total numeric(14, 2) not null default 0,
  amount_paid numeric(14, 2) not null default 0,
  memo text not null default '',
  external_source text,
  external_id text,
  posted_entry_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, kind, number)
);

create unique index if not exists teller_documents_external_idx
  on public.teller_documents (organization_id, kind, external_source, external_id)
  where external_source is not null and external_id is not null;

create index if not exists teller_documents_org_idx
  on public.teller_documents (organization_id, kind, status, issue_date desc);

create table if not exists public.teller_document_lines (
  id uuid primary key default uuid_generate_v4(),
  document_id uuid not null references public.teller_documents (id) on delete cascade,
  description text not null default '',
  quantity numeric(12, 2) not null default 1,
  unit_price numeric(14, 2) not null default 0,
  amount numeric(14, 2) not null default 0,
  account_id uuid references public.teller_accounts (id) on delete set null,
  item_type text not null default 'other',
  sort_order integer not null default 0
);

create index if not exists teller_document_lines_doc_idx
  on public.teller_document_lines (document_id, sort_order);

create table if not exists public.teller_journal_entries (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  entry_date date not null default current_date,
  memo text not null default '',
  source_kind text,
  source_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists teller_journal_entries_org_idx
  on public.teller_journal_entries (organization_id, entry_date desc);

create table if not exists public.teller_journal_lines (
  id uuid primary key default uuid_generate_v4(),
  entry_id uuid not null references public.teller_journal_entries (id) on delete cascade,
  account_id uuid not null references public.teller_accounts (id) on delete restrict,
  debit numeric(14, 2) not null default 0,
  credit numeric(14, 2) not null default 0,
  party_id uuid references public.teller_parties (id) on delete set null,
  job_id uuid references public.teller_jobs (id) on delete set null,
  memo text not null default ''
);

create index if not exists teller_journal_lines_entry_idx
  on public.teller_journal_lines (entry_id);

create index if not exists teller_journal_lines_account_idx
  on public.teller_journal_lines (account_id);

create table if not exists public.teller_integrations (
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  provider text not null,
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz,
  last_sync_summary jsonb,
  updated_at timestamptz not null default now(),
  primary key (organization_id, provider)
);

-- ---------------------------------------------------------------------------
-- RLS helpers
-- ---------------------------------------------------------------------------

create or replace function public.teller_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id
  from public.teller_profiles
  where id = auth.uid()
$$;

create or replace function public.teller_is_org_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.teller_profiles
    where id = auth.uid()
      and organization_id = p_org
  )
$$;

-- Atomic first-time setup: org + profile + settings + chart of accounts.
create or replace function public.teller_complete_setup(
  p_name text,
  p_legal_name text,
  p_industry_id text,
  p_answers jsonb,
  p_modules text[],
  p_labels jsonb,
  p_accounts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text;
  v_full_name text;
  v_org_id uuid;
  v_account jsonb;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if exists (
    select 1 from public.teller_profiles
    where id = v_user_id and organization_id is not null
  ) then
    raise exception 'Books already set up for this user';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Company name is required';
  end if;

  select
    coalesce(u.email, ''),
    coalesce(u.raw_user_meta_data->>'full_name', split_part(coalesce(u.email, ''), '@', 1))
  into v_email, v_full_name
  from auth.users u
  where u.id = v_user_id;

  insert into public.teller_organizations (
    name, legal_name, industry_id, setup_completed_at, created_by
  ) values (
    trim(p_name),
    coalesce(nullif(trim(p_legal_name), ''), trim(p_name)),
    p_industry_id,
    now(),
    v_user_id
  )
  returning id into v_org_id;

  insert into public.teller_profiles (id, organization_id, email, full_name, role)
  values (v_user_id, v_org_id, v_email, v_full_name, 'owner')
  on conflict (id) do update
    set organization_id = excluded.organization_id,
        email = excluded.email,
        full_name = excluded.full_name,
        role = 'owner',
        updated_at = now();

  insert into public.teller_industry_settings (
    organization_id, answers, modules, labels
  ) values (
    v_org_id, coalesce(p_answers, '{}'::jsonb), coalesce(p_modules, '{}'), coalesce(p_labels, '{}'::jsonb)
  );

  if p_accounts is not null then
    for v_account in select * from jsonb_array_elements(p_accounts)
    loop
      insert into public.teller_accounts (
        organization_id, code, name, type, subtype, industry_tag, is_system
      ) values (
        v_org_id,
        v_account->>'code',
        v_account->>'name',
        v_account->>'type',
        coalesce(v_account->>'subtype', ''),
        coalesce(v_account->>'industry_tag', ''),
        true
      );
    end loop;
  end if;

  if coalesce(p_answers->>'connectQuoter', 'false') in ('true', 'yes') then
    insert into public.teller_integrations (organization_id, provider, enabled)
    values (v_org_id, 'quoter', true);
  end if;

  return jsonb_build_object('organization_id', v_org_id);
end;
$$;

grant execute on function public.teller_org_id() to authenticated;
grant execute on function public.teller_is_org_member(uuid) to authenticated;
grant execute on function public.teller_complete_setup(text, text, text, jsonb, text[], jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.teller_organizations enable row level security;
alter table public.teller_profiles enable row level security;
alter table public.teller_industry_settings enable row level security;
alter table public.teller_accounts enable row level security;
alter table public.teller_parties enable row level security;
alter table public.teller_jobs enable row level security;
alter table public.teller_documents enable row level security;
alter table public.teller_document_lines enable row level security;
alter table public.teller_journal_entries enable row level security;
alter table public.teller_journal_lines enable row level security;
alter table public.teller_integrations enable row level security;

create policy "teller members read own org"
  on public.teller_organizations for select
  using (public.teller_is_org_member(id));

create policy "teller members update own org"
  on public.teller_organizations for update
  using (public.teller_is_org_member(id));

create policy "teller users read own profile"
  on public.teller_profiles for select
  using (id = auth.uid() or public.teller_is_org_member(organization_id));

create policy "teller users insert own profile"
  on public.teller_profiles for insert
  with check (id = auth.uid());

create policy "teller users update own profile"
  on public.teller_profiles for update
  using (id = auth.uid());

create policy "teller members manage settings"
  on public.teller_industry_settings for all
  using (public.teller_is_org_member(organization_id))
  with check (public.teller_is_org_member(organization_id));

create policy "teller members manage accounts"
  on public.teller_accounts for all
  using (public.teller_is_org_member(organization_id))
  with check (public.teller_is_org_member(organization_id));

create policy "teller members manage parties"
  on public.teller_parties for all
  using (public.teller_is_org_member(organization_id))
  with check (public.teller_is_org_member(organization_id));

create policy "teller members manage jobs"
  on public.teller_jobs for all
  using (public.teller_is_org_member(organization_id))
  with check (public.teller_is_org_member(organization_id));

create policy "teller members manage documents"
  on public.teller_documents for all
  using (public.teller_is_org_member(organization_id))
  with check (public.teller_is_org_member(organization_id));

create policy "teller members manage document lines"
  on public.teller_document_lines for all
  using (
    exists (
      select 1 from public.teller_documents d
      where d.id = document_id
        and public.teller_is_org_member(d.organization_id)
    )
  )
  with check (
    exists (
      select 1 from public.teller_documents d
      where d.id = document_id
        and public.teller_is_org_member(d.organization_id)
    )
  );

create policy "teller members manage journal entries"
  on public.teller_journal_entries for all
  using (public.teller_is_org_member(organization_id))
  with check (public.teller_is_org_member(organization_id));

create policy "teller members manage journal lines"
  on public.teller_journal_lines for all
  using (
    exists (
      select 1 from public.teller_journal_entries e
      where e.id = entry_id
        and public.teller_is_org_member(e.organization_id)
    )
  )
  with check (
    exists (
      select 1 from public.teller_journal_entries e
      where e.id = entry_id
        and public.teller_is_org_member(e.organization_id)
    )
  );

create policy "teller members manage integrations"
  on public.teller_integrations for all
  using (public.teller_is_org_member(organization_id))
  with check (public.teller_is_org_member(organization_id));
