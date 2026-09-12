-- Phase 16B: Legal entity access, active context, membership RLS.
-- Manual apply only. Does NOT add legal_entity_id to economic tables.

-- ---------------------------------------------------------------------------
-- Active entity preference (server-owned, revalidated on every request)
-- ---------------------------------------------------------------------------

alter table public.teller_profiles
  add column if not exists active_legal_entity_id uuid
    references public.teller_legal_entities (id) on delete set null;

create index if not exists teller_profiles_active_legal_entity_idx
  on public.teller_profiles (active_legal_entity_id)
  where active_legal_entity_id is not null;

-- ---------------------------------------------------------------------------
-- Explicit entity memberships (restricted users only; owner/admin = all entities)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_legal_entity_memberships (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  legal_entity_id uuid not null references public.teller_legal_entities (id) on delete cascade,
  profile_id uuid not null references public.teller_profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (legal_entity_id, profile_id)
);

create index if not exists teller_legal_entity_memberships_org_profile_idx
  on public.teller_legal_entity_memberships (organization_id, profile_id);

create index if not exists teller_legal_entity_memberships_profile_idx
  on public.teller_legal_entity_memberships (profile_id);

-- ---------------------------------------------------------------------------
-- Org consistency guards
-- ---------------------------------------------------------------------------

create or replace function public.teller_legal_entity_membership_org_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity_org uuid;
  v_profile_org uuid;
begin
  select organization_id into v_entity_org
  from public.teller_legal_entities
  where id = NEW.legal_entity_id;

  if v_entity_org is null then
    raise exception 'Legal entity not found';
  end if;

  select organization_id into v_profile_org
  from public.teller_profiles
  where id = NEW.profile_id;

  if v_profile_org is null or v_profile_org is distinct from v_entity_org then
    raise exception 'Profile and legal entity must belong to the same organization';
  end if;

  NEW.organization_id := v_entity_org;
  NEW.updated_at := now();
  return NEW;
end;
$$;

drop trigger if exists teller_legal_entity_membership_org_guard_trg
  on public.teller_legal_entity_memberships;

create trigger teller_legal_entity_membership_org_guard_trg
  before insert or update on public.teller_legal_entity_memberships
  for each row execute function public.teller_legal_entity_membership_org_guard();

create or replace function public.teller_profile_active_entity_org_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity_org uuid;
begin
  if NEW.active_legal_entity_id is null then
    return NEW;
  end if;

  select organization_id into v_entity_org
  from public.teller_legal_entities
  where id = NEW.active_legal_entity_id;

  if v_entity_org is null then
    raise exception 'Active legal entity not found';
  end if;

  if NEW.organization_id is distinct from v_entity_org then
    raise exception 'Active legal entity must belong to the user organization';
  end if;

  return NEW;
end;
$$;

drop trigger if exists teller_profile_active_entity_org_guard_trg
  on public.teller_profiles;

create trigger teller_profile_active_entity_org_guard_trg
  before insert or update on public.teller_profiles
  for each row execute function public.teller_profile_active_entity_org_guard();

-- ---------------------------------------------------------------------------
-- Entity access helpers
-- ---------------------------------------------------------------------------

create or replace function public.teller_has_restricted_entity_access(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.teller_legal_entity_memberships m
    join public.teller_profiles p on p.id = m.profile_id
    where p.id = auth.uid()
      and m.organization_id = p_org
      and p.organization_id = p_org
  );
$$;

create or replace function public.teller_can_access_legal_entity(p_org uuid, p_entity_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.teller_is_org_member(p_org)
    and exists (
      select 1
      from public.teller_legal_entities le
      where le.id = p_entity_id
        and le.organization_id = p_org
    )
    and (
      exists (
        select 1
        from public.teller_profiles p
        where p.id = auth.uid()
          and p.organization_id = p_org
          and p.role in ('owner', 'admin')
      )
      or not public.teller_has_restricted_entity_access(p_org)
      or exists (
        select 1
        from public.teller_legal_entity_memberships m
        where m.profile_id = auth.uid()
          and m.organization_id = p_org
          and m.legal_entity_id = p_entity_id
      )
    );
$$;

-- ---------------------------------------------------------------------------
-- Replace legal entity SELECT policy (avoid permissive OR widening access)
-- ---------------------------------------------------------------------------

drop policy if exists "teller members read legal entities" on public.teller_legal_entities;

create policy "teller members read accessible legal entities"
  on public.teller_legal_entities for select
  using (public.teller_can_access_legal_entity(organization_id, id));

-- ---------------------------------------------------------------------------
-- Membership RLS
-- ---------------------------------------------------------------------------

alter table public.teller_legal_entity_memberships enable row level security;

create policy "teller members read entity memberships"
  on public.teller_legal_entity_memberships for select
  using (
    public.teller_is_org_member(organization_id)
    and (
      profile_id = auth.uid()
      or exists (
        select 1
        from public.teller_profiles p
        where p.id = auth.uid()
          and p.organization_id = organization_id
          and p.role in ('owner', 'admin')
      )
    )
  );

create policy "teller admins manage entity memberships"
  on public.teller_legal_entity_memberships for insert
  with check (
    public.teller_is_org_member(organization_id)
    and exists (
      select 1
      from public.teller_profiles p
      where p.id = auth.uid()
        and p.organization_id = organization_id
        and p.role in ('owner', 'admin')
    )
  );

create policy "teller admins update entity memberships"
  on public.teller_legal_entity_memberships for update
  using (
    public.teller_is_org_member(organization_id)
    and exists (
      select 1
      from public.teller_profiles p
      where p.id = auth.uid()
        and p.organization_id = organization_id
        and p.role in ('owner', 'admin')
    )
  )
  with check (
    public.teller_is_org_member(organization_id)
    and exists (
      select 1
      from public.teller_profiles p
      where p.id = auth.uid()
        and p.organization_id = organization_id
        and p.role in ('owner', 'admin')
    )
  );

create policy "teller admins delete entity memberships"
  on public.teller_legal_entity_memberships for delete
  using (
    public.teller_is_org_member(organization_id)
    and exists (
      select 1
      from public.teller_profiles p
      where p.id = auth.uid()
        and p.organization_id = organization_id
        and p.role in ('owner', 'admin')
    )
  );

-- ---------------------------------------------------------------------------
-- Controlled default entity change (no history rewrite)
-- ---------------------------------------------------------------------------

create or replace function public.teller_set_default_legal_entity(
  p_org_id uuid,
  p_entity_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity record;
begin
  if p_org_id is null or p_entity_id is null then
    raise exception 'Organization and legal entity are required';
  end if;

  if auth.uid() is not null
     and not public.teller_can_access_legal_entity(p_org_id, p_entity_id) then
    raise exception 'You do not have access to this legal entity';
  end if;

  select id, organization_id, is_active
  into v_entity
  from public.teller_legal_entities
  where id = p_entity_id;

  if v_entity.id is null or v_entity.organization_id is distinct from p_org_id then
    raise exception 'Legal entity not found';
  end if;

  if not v_entity.is_active then
    raise exception 'Inactive legal entity cannot be default';
  end if;

  if exists (
    select 1
    from public.teller_integrations i
    where i.organization_id = p_org_id
      and i.provider = 'hfac'
      and i.enabled = true
  ) then
    raise exception 'Default legal entity cannot be changed while Hassle Free AC integration is active';
  end if;

  update public.teller_legal_entities
  set is_default = false,
      updated_at = now()
  where organization_id = p_org_id
    and is_default
    and is_active
    and id <> p_entity_id;

  update public.teller_legal_entities
  set is_default = true,
      updated_at = now()
  where id = p_entity_id
    and organization_id = p_org_id;

  return p_entity_id;
end;
$$;

grant execute on function public.teller_set_default_legal_entity(uuid, uuid) to authenticated;
grant execute on function public.teller_set_default_legal_entity(uuid, uuid) to service_role;
