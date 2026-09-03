-- Partner attachment: Teller stays its own app; orgs can link to Hassle Free AC / Quoter.

alter table public.teller_organizations
  add column if not exists partner_id text;

create index if not exists teller_organizations_partner_idx
  on public.teller_organizations (partner_id)
  where partner_id is not null;

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
    name, legal_name, industry_id, partner_id, setup_completed_at, created_by
  ) values (
    trim(p_name),
    coalesce(nullif(trim(p_legal_name), ''), trim(p_name)),
    p_industry_id,
    v_partner,
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

  if coalesce(p_answers->>'connectQuoter', 'false') in ('true', 'yes')
     or v_partner = 'hasslefreeac' then
    insert into public.teller_integrations (organization_id, provider, enabled)
    values (v_org_id, 'quoter', true);
  end if;

  return jsonb_build_object('organization_id', v_org_id, 'partner_id', v_partner);
end;
$$;

grant execute on function public.teller_complete_setup(text, text, text, text, jsonb, text[], jsonb, jsonb) to authenticated;
