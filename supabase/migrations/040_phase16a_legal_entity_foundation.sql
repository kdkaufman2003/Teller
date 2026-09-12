-- Phase 16A: Legal entity foundation (tenant vs books separation).
-- Manual apply only. Does NOT add legal_entity_id to economic tables yet.

create table if not exists public.teller_legal_entities (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  name text not null,
  legal_name text not null,
  entity_code text not null,
  entity_type text not null default 'other'
    check (entity_type in ('llc', 'corporation', 'partnership', 'sole_proprietorship', 'other')),
  tax_identifier_last4 text not null default '',
  country_code text not null default 'US',
  state_code text not null default '',
  base_currency text not null default 'USD',
  is_default boolean not null default false,
  is_active boolean not null default true,
  consolidation_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teller_legal_entities_code_nonempty check (char_length(trim(entity_code)) > 0),
  constraint teller_legal_entities_name_nonempty check (char_length(trim(name)) > 0),
  unique (organization_id, entity_code)
);

create index if not exists teller_legal_entities_org_active_idx
  on public.teller_legal_entities (organization_id, is_active, is_default desc, name);

create unique index if not exists teller_legal_entities_one_default_per_org
  on public.teller_legal_entities (organization_id)
  where is_default and is_active;

alter table public.teller_legal_entities enable row level security;

create policy "teller members read legal entities"
  on public.teller_legal_entities for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage legal entities"
  on public.teller_legal_entities for insert
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create policy "teller writers update legal entities"
  on public.teller_legal_entities for update
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- No DELETE policy: archive via is_active = false (Phase 16A).

create or replace function public.teller_seed_default_legal_entity(p_org_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing uuid;
  v_org record;
  v_entity_id uuid;
begin
  if p_org_id is null then
    raise exception 'Organization id is required';
  end if;

  select id into v_existing
  from public.teller_legal_entities
  where organization_id = p_org_id
    and is_default
    and is_active
  limit 1;

  if v_existing is not null then
    return v_existing;
  end if;

  select id, name, legal_name, country, state, currency
  into v_org
  from public.teller_organizations
  where id = p_org_id;

  if v_org.id is null then
    raise exception 'Organization not found';
  end if;

  insert into public.teller_legal_entities (
    organization_id,
    name,
    legal_name,
    entity_code,
    entity_type,
    country_code,
    state_code,
    base_currency,
    is_default,
    is_active
  ) values (
    p_org_id,
    v_org.name,
    coalesce(nullif(trim(v_org.legal_name), ''), v_org.name),
    'MAIN',
    'other',
    coalesce(nullif(trim(v_org.country), ''), 'US'),
    coalesce(nullif(trim(v_org.state), ''), ''),
    coalesce(nullif(trim(v_org.currency), ''), 'USD'),
    true,
    true
  )
  on conflict (organization_id, entity_code) do update
    set
      is_default = true,
      is_active = true,
      updated_at = now()
  returning id into v_entity_id;

  return v_entity_id;
end;
$$;

grant execute on function public.teller_seed_default_legal_entity(uuid) to authenticated;
grant execute on function public.teller_seed_default_legal_entity(uuid) to service_role;

-- Backfill: one default legal entity per setup-completed organization (idempotent).
insert into public.teller_legal_entities (
  organization_id,
  name,
  legal_name,
  entity_code,
  entity_type,
  country_code,
  state_code,
  base_currency,
  is_default,
  is_active
)
select
  o.id,
  o.name,
  coalesce(nullif(trim(o.legal_name), ''), o.name),
  'MAIN',
  'other',
  coalesce(nullif(trim(o.country), ''), 'US'),
  coalesce(nullif(trim(o.state), ''), ''),
  coalesce(nullif(trim(o.currency), ''), 'USD'),
  true,
  true
from public.teller_organizations o
where o.setup_completed_at is not null
  and not exists (
    select 1
    from public.teller_legal_entities le
    where le.organization_id = o.id
      and le.is_default
      and le.is_active
  );

-- Extend setup RPC: every new org receives a default legal entity.
create or replace function public.teller_complete_setup(
  p_name text,
  p_legal_name text,
  p_industry_id text,
  p_partner_id text,
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
  v_entity_id uuid;
  v_account jsonb;
  v_partner text := nullif(trim(p_partner_id), '');
  v_source text := 'direct';
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

  if v_partner = 'hasslefreeac' then
    v_source := 'hfac';
  elsif v_partner is not null then
    v_source := 'partner';
  end if;

  select
    coalesce(u.email, ''),
    coalesce(u.raw_user_meta_data->>'full_name', split_part(coalesce(u.email, ''), '@', 1))
  into v_email, v_full_name
  from auth.users u
  where u.id = v_user_id;

  insert into public.teller_organizations (
    name, legal_name, industry_id, partner_id, organization_source, setup_completed_at, created_by
  ) values (
    trim(p_name),
    coalesce(nullif(trim(p_legal_name), ''), trim(p_name)),
    p_industry_id,
    v_partner,
    v_source,
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

  if v_partner is not null then
    insert into public.teller_integrations (organization_id, provider, enabled, config)
    values (
      v_org_id,
      v_partner,
      true,
      jsonb_build_object('attached_at', now())
    );
  end if;

  if v_partner = 'hasslefreeac'
     or coalesce(p_answers->>'connectHfac', 'false') in ('true', 'yes')
     or coalesce(p_answers->>'connectQuoter', 'false') in ('true', 'yes') then
    insert into public.teller_integrations (organization_id, provider, enabled)
    values (v_org_id, 'hfac', true);
  end if;

  v_entity_id := public.teller_seed_default_legal_entity(v_org_id);

  return jsonb_build_object(
    'organization_id', v_org_id,
    'legal_entity_id', v_entity_id,
    'partner_id', v_partner,
    'organization_source', v_source
  );
end;
$$;

grant execute on function public.teller_complete_setup(text, text, text, text, jsonb, text[], jsonb, jsonb) to authenticated;
