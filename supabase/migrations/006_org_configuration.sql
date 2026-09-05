-- Phase 2: organization configuration — source, profile, locations stub

alter table public.teller_organizations
  add column if not exists organization_source text not null default 'direct'
    check (organization_source in ('direct', 'hfac', 'partner')),
  add column if not exists phone text not null default '',
  add column if not exists timezone text not null default 'America/Chicago',
  add column if not exists currency text not null default 'USD',
  add column if not exists address_line1 text not null default '',
  add column if not exists address_line2 text not null default '',
  add column if not exists city text not null default '',
  add column if not exists state text not null default '',
  add column if not exists postal_code text not null default '',
  add column if not exists country text not null default 'US';

update public.teller_organizations
set organization_source = 'hfac'
where partner_id = 'hasslefreeac';

update public.teller_organizations
set organization_source = 'partner'
where partner_id is not null
  and partner_id <> 'hasslefreeac';

-- Multi-location stub (Phase 2 foundation; UI comes later)
create table if not exists public.teller_locations (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  name text not null,
  is_primary boolean not null default false,
  address_line1 text not null default '',
  address_line2 text not null default '',
  city text not null default '',
  state text not null default '',
  postal_code text not null default '',
  country text not null default 'US',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists teller_locations_org_idx
  on public.teller_locations (organization_id, is_primary desc, name);

alter table public.teller_locations enable row level security;

create policy "teller members read locations"
  on public.teller_locations for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage locations"
  on public.teller_locations for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- Align setup RPC with attachPartner() integration providers
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

  return jsonb_build_object(
    'organization_id', v_org_id,
    'partner_id', v_partner,
    'organization_source', v_source
  );
end;
$$;

grant execute on function public.teller_complete_setup(text, text, text, text, jsonb, text[], jsonb, jsonb) to authenticated;
