-- Platform operators (HF Tech) — separate from tenant owner/admin roles.

create table if not exists public.teller_platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  note text not null default '',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.teller_platform_admins enable row level security;

create policy "users read own platform admin flag"
  on public.teller_platform_admins for select
  using (user_id = auth.uid());

create or replace function public.teller_is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.teller_platform_admins where user_id = auth.uid()
  );
$$;

grant execute on function public.teller_is_platform_admin() to authenticated;

-- Provision books for a user created by platform admin (service role only).
create or replace function public.teller_platform_complete_setup(
  p_user_id uuid,
  p_email text,
  p_full_name text,
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
  v_org_id uuid;
  v_entity_id uuid;
  v_account jsonb;
  v_partner text := nullif(trim(p_partner_id), '');
  v_source text := 'direct';
begin
  if p_user_id is null then
    raise exception 'User id is required';
  end if;

  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'Auth user not found';
  end if;

  if exists (
    select 1 from public.teller_profiles
    where id = p_user_id and organization_id is not null
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

  insert into public.teller_organizations (
    name, legal_name, industry_id, partner_id, organization_source, setup_completed_at, created_by
  ) values (
    trim(p_name),
    coalesce(nullif(trim(p_legal_name), ''), trim(p_name)),
    p_industry_id,
    v_partner,
    v_source,
    now(),
    p_user_id
  )
  returning id into v_org_id;

  insert into public.teller_profiles (id, organization_id, email, full_name, role)
  values (
    p_user_id,
    v_org_id,
    coalesce(nullif(trim(p_email), ''), ''),
    coalesce(nullif(trim(p_full_name), ''), split_part(coalesce(p_email, ''), '@', 1)),
    'owner'
  )
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

revoke all on function public.teller_platform_complete_setup(
  uuid, text, text, text, text, text, text, jsonb, text[], jsonb, jsonb
) from public;
grant execute on function public.teller_platform_complete_setup(
  uuid, text, text, text, text, text, text, jsonb, text[], jsonb, jsonb
) to service_role;

-- Attach an existing auth user to an existing org (service role only).
create or replace function public.teller_platform_attach_org_member(
  p_user_id uuid,
  p_organization_id uuid,
  p_email text,
  p_full_name text,
  p_role text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null or p_organization_id is null then
    raise exception 'User and organization are required';
  end if;

  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'Auth user not found';
  end if;

  if not exists (select 1 from public.teller_organizations where id = p_organization_id) then
    raise exception 'Organization not found';
  end if;

  if p_role is null or p_role not in ('owner', 'admin', 'bookkeeper', 'viewer') then
    raise exception 'Invalid role';
  end if;

  if exists (
    select 1 from public.teller_profiles
    where id = p_user_id and organization_id is not null
  ) then
    raise exception 'User already belongs to an organization';
  end if;

  insert into public.teller_profiles (id, organization_id, email, full_name, role)
  values (
    p_user_id,
    p_organization_id,
    coalesce(nullif(trim(p_email), ''), ''),
    coalesce(nullif(trim(p_full_name), ''), split_part(coalesce(p_email, ''), '@', 1)),
    p_role
  )
  on conflict (id) do update
    set organization_id = excluded.organization_id,
        email = excluded.email,
        full_name = excluded.full_name,
        role = excluded.role,
        updated_at = now();

  return jsonb_build_object(
    'user_id', p_user_id,
    'organization_id', p_organization_id,
    'role', p_role
  );
end;
$$;

revoke all on function public.teller_platform_attach_org_member(uuid, uuid, text, text, text) from public;
grant execute on function public.teller_platform_attach_org_member(uuid, uuid, text, text, text) to service_role;
