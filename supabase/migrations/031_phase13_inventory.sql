-- Phase 13: Inventory accounting & stock control (additive, Phase 12 compatible)
-- Includes GRNI (Goods Received Not Invoiced) receipt recognition and bill settlement.
-- Local only — do not apply to production until Phase 13 acceptance.
-- V1 valuation: weighted average cost. V1 PPV: deterministic PPV account, no auto-capitalization.
-- Serial/lot tracking deferred.

-- ---------------------------------------------------------------------------
-- Inventory items (accounting identity / SKU master)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_inventory_items (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  sku text not null,
  name text not null,
  description text not null default '',
  item_type text not null default 'inventory',
  unit_of_measure text not null default 'each',
  active boolean not null default true,
  inventory_asset_account_id uuid not null references public.teller_accounts (id),
  cogs_account_id uuid not null references public.teller_accounts (id),
  purchase_account_id uuid references public.teller_accounts (id),
  default_vendor_id uuid references public.teller_parties (id),
  valuation_method text not null default 'weighted_average',
  is_serialized boolean not null default false,
  is_lot_tracked boolean not null default false,
  allow_negative_stock boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teller_inventory_items_type_check check (item_type in ('inventory', 'non_inventory', 'service')),
  constraint teller_inventory_items_valuation_check check (valuation_method in ('weighted_average')),
  unique (organization_id, sku)
);

create index if not exists teller_inventory_items_org_active_idx
  on public.teller_inventory_items (organization_id, active);

create index if not exists teller_inventory_items_org_sku_idx
  on public.teller_inventory_items (organization_id, sku);

alter table public.teller_inventory_items enable row level security;

create policy "teller members read inventory items"
  on public.teller_inventory_items for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage inventory items"
  on public.teller_inventory_items for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Inventory locations
-- ---------------------------------------------------------------------------

create table if not exists public.teller_inventory_locations (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  name text not null,
  location_type text not null default 'warehouse',
  active boolean not null default true,
  external_source text,
  external_location_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teller_inventory_locations_type_check check (location_type in ('warehouse', 'vehicle', 'staging', 'other')),
  unique (organization_id, name)
);

create index if not exists teller_inventory_locations_org_active_idx
  on public.teller_inventory_locations (organization_id, active);

alter table public.teller_inventory_locations enable row level security;

create policy "teller members read inventory locations"
  on public.teller_inventory_locations for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage inventory locations"
  on public.teller_inventory_locations for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Transfer groups (linked transfer_out / transfer_in pairs)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_inventory_transfer_groups (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  inventory_item_id uuid not null references public.teller_inventory_items (id),
  from_location_id uuid not null references public.teller_inventory_locations (id),
  to_location_id uuid not null references public.teller_inventory_locations (id),
  quantity numeric(14, 4) not null,
  unit_cost numeric(14, 4) not null default 0,
  extended_cost numeric(14, 2) not null default 0,
  status text not null default 'posted',
  idempotency_key text not null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint teller_inventory_transfer_groups_status_check check (status in ('posted', 'reversed')),
  unique (organization_id, idempotency_key)
);

create index if not exists teller_inventory_transfer_groups_org_item_idx
  on public.teller_inventory_transfer_groups (organization_id, inventory_item_id);

alter table public.teller_inventory_transfer_groups enable row level security;

create policy "teller members read inventory transfer groups"
  on public.teller_inventory_transfer_groups for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage inventory transfer groups"
  on public.teller_inventory_transfer_groups for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Cached per-item/per-location valuation state
-- ---------------------------------------------------------------------------

create table if not exists public.teller_inventory_balances (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  inventory_item_id uuid not null references public.teller_inventory_items (id),
  location_id uuid not null references public.teller_inventory_locations (id),
  quantity_on_hand numeric(14, 4) not null default 0,
  inventory_value numeric(14, 2) not null default 0,
  weighted_average_unit_cost numeric(14, 4) not null default 0,
  updated_at timestamptz not null default now(),
  unique (organization_id, inventory_item_id, location_id)
);

create index if not exists teller_inventory_balances_org_item_location_idx
  on public.teller_inventory_balances (organization_id, inventory_item_id, location_id);

create index if not exists teller_inventory_balances_org_location_idx
  on public.teller_inventory_balances (organization_id, location_id);

alter table public.teller_inventory_balances enable row level security;

create policy "teller members read inventory balances"
  on public.teller_inventory_balances for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage inventory balances"
  on public.teller_inventory_balances for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Append-only movement ledger
-- ---------------------------------------------------------------------------

create table if not exists public.teller_inventory_movements (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  inventory_item_id uuid not null references public.teller_inventory_items (id),
  location_id uuid not null references public.teller_inventory_locations (id),
  movement_type text not null,
  quantity_delta numeric(14, 4) not null,
  unit_cost numeric(14, 4) not null default 0,
  extended_cost numeric(14, 2) not null default 0,
  source_type text,
  source_id uuid,
  job_id uuid references public.teller_jobs (id),
  vendor_id uuid references public.teller_parties (id),
  transfer_group_id uuid references public.teller_inventory_transfer_groups (id),
  journal_entry_id uuid references public.teller_journal_entries (id),
  reversal_of_movement_id uuid references public.teller_inventory_movements (id),
  reversed_by_movement_id uuid references public.teller_inventory_movements (id),
  idempotency_key text not null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint teller_inventory_movements_type_check check (
    movement_type in (
      'purchase_receipt',
      'transfer_out',
      'transfer_in',
      'job_issue',
      'job_return',
      'vendor_return',
      'adjustment_in',
      'adjustment_out',
      'opening_balance',
      'reversal'
    )
  ),
  unique (organization_id, idempotency_key)
);

create index if not exists teller_inventory_movements_org_item_idx
  on public.teller_inventory_movements (organization_id, inventory_item_id);

create index if not exists teller_inventory_movements_org_location_idx
  on public.teller_inventory_movements (organization_id, location_id);

create index if not exists teller_inventory_movements_org_item_location_idx
  on public.teller_inventory_movements (organization_id, inventory_item_id, location_id);

create index if not exists teller_inventory_movements_org_occurred_idx
  on public.teller_inventory_movements (organization_id, occurred_at);

create index if not exists teller_inventory_movements_org_type_idx
  on public.teller_inventory_movements (organization_id, movement_type);

create index if not exists teller_inventory_movements_org_job_idx
  on public.teller_inventory_movements (organization_id, job_id);

create index if not exists teller_inventory_movements_org_source_idx
  on public.teller_inventory_movements (organization_id, source_type, source_id);

alter table public.teller_inventory_movements enable row level security;

create policy "teller members read inventory movements"
  on public.teller_inventory_movements for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage inventory movements"
  on public.teller_inventory_movements for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Physical inventory counts
-- ---------------------------------------------------------------------------

create table if not exists public.teller_inventory_counts (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  location_id uuid not null references public.teller_inventory_locations (id),
  status text not null default 'draft',
  count_date date not null,
  posted_at timestamptz,
  posted_by uuid,
  journal_entry_id uuid references public.teller_journal_entries (id),
  idempotency_key text,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teller_inventory_counts_status_check check (
    status in ('draft', 'in_progress', 'reviewed', 'posted', 'cancelled')
  )
);

create index if not exists teller_inventory_counts_org_status_idx
  on public.teller_inventory_counts (organization_id, status);

alter table public.teller_inventory_counts enable row level security;

create policy "teller members read inventory counts"
  on public.teller_inventory_counts for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage inventory counts"
  on public.teller_inventory_counts for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create table if not exists public.teller_inventory_count_lines (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  inventory_count_id uuid not null references public.teller_inventory_counts (id) on delete cascade,
  inventory_item_id uuid not null references public.teller_inventory_items (id),
  system_quantity numeric(14, 4) not null default 0,
  counted_quantity numeric(14, 4) not null default 0,
  variance_quantity numeric(14, 4) not null default 0,
  unit_cost numeric(14, 4) not null default 0,
  value_variance numeric(14, 2) not null default 0,
  adjustment_reason text,
  created_at timestamptz not null default now(),
  unique (inventory_count_id, inventory_item_id)
);

create index if not exists teller_inventory_count_lines_org_count_idx
  on public.teller_inventory_count_lines (organization_id, inventory_count_id);

alter table public.teller_inventory_count_lines enable row level security;

create policy "teller members read inventory count lines"
  on public.teller_inventory_count_lines for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage inventory count lines"
  on public.teller_inventory_count_lines for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Weighted-average balance helpers (cent-safe)
-- ---------------------------------------------------------------------------

create or replace function public.teller_inventory_round_money(p_amount numeric)
returns numeric
language sql
immutable
as $$
  select round(coalesce(p_amount, 0), 2);
$$;

create or replace function public.teller_inventory_apply_receipt(
  p_qty numeric,
  p_value numeric,
  p_wac numeric,
  p_receipt_qty numeric,
  p_receipt_unit_cost numeric
)
returns table (
  quantity_on_hand numeric,
  inventory_value numeric,
  weighted_average_unit_cost numeric
)
language plpgsql
immutable
as $$
declare
  v_receipt_value numeric;
  v_qty numeric;
  v_value numeric;
  v_wac numeric;
begin
  v_receipt_value := public.teller_inventory_round_money(p_receipt_qty * p_receipt_unit_cost);
  v_qty := round(coalesce(p_qty, 0) + p_receipt_qty, 4);
  v_value := public.teller_inventory_round_money(coalesce(p_value, 0) + v_receipt_value);
  if v_qty <= 0.0001 then
    v_wac := 0;
  else
    v_wac := round(v_value / v_qty, 4);
  end if;
  return query select v_qty, v_value, v_wac;
end;
$$;

create or replace function public.teller_inventory_apply_issue(
  p_qty numeric,
  p_value numeric,
  p_wac numeric,
  p_issue_qty numeric,
  p_allow_negative boolean default false
)
returns table (
  quantity_on_hand numeric,
  inventory_value numeric,
  weighted_average_unit_cost numeric,
  cogs_amount numeric,
  unit_cost_applied numeric
)
language plpgsql
immutable
as $$
declare
  v_unit_cost numeric;
  v_cogs numeric;
  v_qty numeric;
  v_value numeric;
  v_wac numeric;
begin
  if p_issue_qty <= 0 then
    raise exception 'Issue quantity must be positive';
  end if;
  if not p_allow_negative and p_issue_qty - coalesce(p_qty, 0) > 0.0001 then
    raise exception 'Insufficient inventory';
  end if;
  v_unit_cost := case when coalesce(p_qty, 0) <= 0.0001 then coalesce(p_wac, 0) else coalesce(p_wac, 0) end;
  v_cogs := public.teller_inventory_round_money(p_issue_qty * v_unit_cost);
  v_qty := round(coalesce(p_qty, 0) - p_issue_qty, 4);
  v_value := public.teller_inventory_round_money(greatest(0, coalesce(p_value, 0) - v_cogs));
  if v_qty <= 0.0001 then
    v_wac := v_unit_cost;
  else
    v_wac := round(v_value / v_qty, 4);
  end if;
  return query select v_qty, v_value, v_wac, v_cogs, v_unit_cost;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lock / upsert balance row for concurrency
-- ---------------------------------------------------------------------------

create or replace function public.teller_inventory_lock_balance(
  p_organization_id uuid,
  p_inventory_item_id uuid,
  p_location_id uuid
)
returns public.teller_inventory_balances
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_balance public.teller_inventory_balances%rowtype;
begin
  insert into public.teller_inventory_balances (
    organization_id,
    inventory_item_id,
    location_id
  )
  values (p_organization_id, p_inventory_item_id, p_location_id)
  on conflict (organization_id, inventory_item_id, location_id) do nothing;

  select * into v_balance
  from public.teller_inventory_balances
  where organization_id = p_organization_id
    and inventory_item_id = p_inventory_item_id
    and location_id = p_location_id
  for update;

  return v_balance;
end;
$$;

grant execute on function public.teller_inventory_lock_balance(uuid, uuid, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Atomic receive inventory (quantity + optional journal when not bill-linked)
-- ---------------------------------------------------------------------------

create or replace function public.teller_atomic_receive_inventory(
  p_organization_id uuid,
  p_inventory_item_id uuid,
  p_location_id uuid,
  p_quantity numeric,
  p_unit_cost numeric,
  p_movement_type text,
  p_source_type text,
  p_source_id uuid,
  p_idempotency_key text,
  p_entry_date date default null,
  p_journal_lines jsonb default null,
  p_journal_source_kind text default null,
  p_journal_source_id uuid default null,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_item public.teller_inventory_items%rowtype;
  v_location public.teller_inventory_locations%rowtype;
  v_balance public.teller_inventory_balances%rowtype;
  v_existing public.teller_inventory_movements%rowtype;
  v_movement_id uuid;
  v_journal_id uuid;
  v_new_qty numeric;
  v_new_value numeric;
  v_new_wac numeric;
  v_extended numeric;
  v_closed_through date;
begin
  if auth.uid() is not null and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to receive inventory';
  end if;

  perform public.teller_acquire_org_accounting_lock(p_organization_id);

  if p_entry_date is not null then
    v_closed_through := public.teller_books_closed_through(p_organization_id);
    if v_closed_through is not null and p_entry_date <= v_closed_through then
      raise exception 'Accounting period is closed through %', v_closed_through;
    end if;
  end if;

  select * into v_existing
  from public.teller_inventory_movements
  where organization_id = p_organization_id
    and idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object(
      'duplicate', true,
      'movement_id', v_existing.id,
      'journal_entry_id', v_existing.journal_entry_id
    );
  end if;

  select * into v_item
  from public.teller_inventory_items
  where id = p_inventory_item_id and organization_id = p_organization_id;
  if not found then raise exception 'Inventory item not found in organization'; end if;
  if v_item.item_type <> 'inventory' then raise exception 'Item is not an inventory item'; end if;

  select * into v_location
  from public.teller_inventory_locations
  where id = p_location_id and organization_id = p_organization_id;
  if not found then raise exception 'Inventory location not found in organization'; end if;

  v_balance := public.teller_inventory_lock_balance(p_organization_id, p_inventory_item_id, p_location_id);

  select quantity_on_hand, inventory_value, weighted_average_unit_cost
  into v_new_qty, v_new_value, v_new_wac
  from public.teller_inventory_apply_receipt(
    v_balance.quantity_on_hand,
    v_balance.inventory_value,
    v_balance.weighted_average_unit_cost,
    p_quantity,
    p_unit_cost
  );

  v_extended := public.teller_inventory_round_money(p_quantity * p_unit_cost);

  if p_journal_lines is not null and p_entry_date is not null then
    v_journal_id := public.teller_post_journal(
      p_organization_id,
      p_entry_date,
      coalesce(p_movement_type, 'inventory receipt'),
      coalesce(p_journal_source_kind, 'inventory_movement'),
      coalesce(p_journal_source_id, gen_random_uuid()),
      null,
      p_journal_lines
    );
  end if;

  insert into public.teller_inventory_movements (
    organization_id, inventory_item_id, location_id, movement_type,
    quantity_delta, unit_cost, extended_cost, source_type, source_id,
    journal_entry_id, idempotency_key, occurred_at
  )
  values (
    p_organization_id, p_inventory_item_id, p_location_id, p_movement_type,
    p_quantity, p_unit_cost, v_extended, p_source_type, p_source_id,
    v_journal_id, p_idempotency_key, coalesce(p_entry_date::timestamptz, now())
  )
  returning id into v_movement_id;

  update public.teller_inventory_balances
  set
    quantity_on_hand = v_new_qty,
    inventory_value = v_new_value,
    weighted_average_unit_cost = v_new_wac,
    updated_at = now()
  where id = v_balance.id;

  return jsonb_build_object(
    'duplicate', false,
    'movement_id', v_movement_id,
    'journal_entry_id', v_journal_id,
    'quantity_on_hand', v_new_qty,
    'inventory_value', v_new_value,
    'weighted_average_unit_cost', v_new_wac
  );
end;
$$;

grant execute on function public.teller_atomic_receive_inventory(
  uuid, uuid, uuid, numeric, numeric, text, text, uuid, text, date, jsonb, text, uuid, uuid
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Atomic issue inventory (job consumption, vendor return quantity, etc.)
-- ---------------------------------------------------------------------------

create or replace function public.teller_atomic_issue_inventory(
  p_organization_id uuid,
  p_inventory_item_id uuid,
  p_location_id uuid,
  p_quantity numeric,
  p_movement_type text,
  p_idempotency_key text,
  p_job_id uuid default null,
  p_vendor_id uuid default null,
  p_source_type text default null,
  p_source_id uuid default null,
  p_entry_date date default null,
  p_journal_lines jsonb default null,
  p_journal_source_kind text default null,
  p_journal_source_id uuid default null,
  p_issue_unit_cost numeric default null,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_item public.teller_inventory_items%rowtype;
  v_balance public.teller_inventory_balances%rowtype;
  v_existing public.teller_inventory_movements%rowtype;
  v_movement_id uuid;
  v_journal_id uuid;
  v_new_qty numeric;
  v_new_value numeric;
  v_new_wac numeric;
  v_cogs numeric;
  v_unit_cost numeric;
  v_extended numeric;
  v_closed_through date;
begin
  if auth.uid() is not null and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to issue inventory';
  end if;

  perform public.teller_acquire_org_accounting_lock(p_organization_id);

  if p_entry_date is not null then
    v_closed_through := public.teller_books_closed_through(p_organization_id);
    if v_closed_through is not null and p_entry_date <= v_closed_through then
      raise exception 'Accounting period is closed through %', v_closed_through;
    end if;
  end if;

  select * into v_existing
  from public.teller_inventory_movements
  where organization_id = p_organization_id
    and idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object(
      'duplicate', true,
      'movement_id', v_existing.id,
      'journal_entry_id', v_existing.journal_entry_id
    );
  end if;

  select * into v_item
  from public.teller_inventory_items
  where id = p_inventory_item_id and organization_id = p_organization_id;
  if not found then raise exception 'Inventory item not found in organization'; end if;

  v_balance := public.teller_inventory_lock_balance(p_organization_id, p_inventory_item_id, p_location_id);

  if p_issue_unit_cost is not null then
    v_unit_cost := p_issue_unit_cost;
    v_cogs := public.teller_inventory_round_money(p_quantity * v_unit_cost);
    if not v_item.allow_negative_stock and p_quantity - v_balance.quantity_on_hand > 0.0001 then
      raise exception 'Insufficient inventory';
    end if;
    v_new_qty := round(v_balance.quantity_on_hand - p_quantity, 4);
    v_new_value := public.teller_inventory_round_money(greatest(0, v_balance.inventory_value - v_cogs));
    v_new_wac := case when v_new_qty <= 0.0001 then v_unit_cost else round(v_new_value / v_new_qty, 4) end;
  else
    select quantity_on_hand, inventory_value, weighted_average_unit_cost, cogs_amount, unit_cost_applied
    into v_new_qty, v_new_value, v_new_wac, v_cogs, v_unit_cost
    from public.teller_inventory_apply_issue(
      v_balance.quantity_on_hand,
      v_balance.inventory_value,
      v_balance.weighted_average_unit_cost,
      p_quantity,
      v_item.allow_negative_stock
    );
  end if;

  v_extended := v_cogs;

  if p_journal_lines is not null and p_entry_date is not null then
    v_journal_id := public.teller_post_journal(
      p_organization_id,
      p_entry_date,
      coalesce(p_movement_type, 'inventory issue'),
      coalesce(p_journal_source_kind, 'inventory_movement'),
      coalesce(p_journal_source_id, gen_random_uuid()),
      null,
      p_journal_lines
    );
  end if;

  insert into public.teller_inventory_movements (
    organization_id, inventory_item_id, location_id, movement_type,
    quantity_delta, unit_cost, extended_cost, source_type, source_id,
    job_id, vendor_id, journal_entry_id, idempotency_key, occurred_at
  )
  values (
    p_organization_id, p_inventory_item_id, p_location_id, p_movement_type,
    -p_quantity, v_unit_cost, v_extended, p_source_type, p_source_id,
    p_job_id, p_vendor_id, v_journal_id, p_idempotency_key, coalesce(p_entry_date::timestamptz, now())
  )
  returning id into v_movement_id;

  update public.teller_inventory_balances
  set
    quantity_on_hand = v_new_qty,
    inventory_value = v_new_value,
    weighted_average_unit_cost = v_new_wac,
    updated_at = now()
  where id = v_balance.id;

  return jsonb_build_object(
    'duplicate', false,
    'movement_id', v_movement_id,
    'journal_entry_id', v_journal_id,
    'cogs_amount', v_cogs,
    'unit_cost_applied', v_unit_cost,
    'quantity_on_hand', v_new_qty,
    'inventory_value', v_new_value
  );
end;
$$;

grant execute on function public.teller_atomic_issue_inventory(
  uuid, uuid, uuid, numeric, text, text, uuid, uuid, text, uuid, date, jsonb, text, uuid, numeric, uuid
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Atomic transfer (no org-wide GL)
-- ---------------------------------------------------------------------------

create or replace function public.teller_atomic_transfer_inventory(
  p_organization_id uuid,
  p_inventory_item_id uuid,
  p_from_location_id uuid,
  p_to_location_id uuid,
  p_quantity numeric,
  p_idempotency_key text,
  p_occurred_at timestamptz default now(),
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_item public.teller_inventory_items%rowtype;
  v_from public.teller_inventory_balances%rowtype;
  v_to public.teller_inventory_balances%rowtype;
  v_existing uuid;
  v_group_id uuid;
  v_out_qty numeric;
  v_out_value numeric;
  v_out_wac numeric;
  v_cogs numeric;
  v_unit_cost numeric;
  v_in_qty numeric;
  v_in_value numeric;
  v_in_wac numeric;
  v_out_movement_id uuid;
  v_in_movement_id uuid;
begin
  if auth.uid() is not null and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to transfer inventory';
  end if;

  perform public.teller_acquire_org_accounting_lock(p_organization_id);

  select id into v_existing
  from public.teller_inventory_transfer_groups
  where organization_id = p_organization_id and idempotency_key = p_idempotency_key;

  if v_existing is not null then
    return jsonb_build_object('duplicate', true, 'transfer_group_id', v_existing);
  end if;

  select * into v_item
  from public.teller_inventory_items
  where id = p_inventory_item_id and organization_id = p_organization_id;
  if not found then raise exception 'Inventory item not found'; end if;

  v_from := public.teller_inventory_lock_balance(p_organization_id, p_inventory_item_id, p_from_location_id);
  v_to := public.teller_inventory_lock_balance(p_organization_id, p_inventory_item_id, p_to_location_id);

  select quantity_on_hand, inventory_value, weighted_average_unit_cost, cogs_amount, unit_cost_applied
  into v_out_qty, v_out_value, v_out_wac, v_cogs, v_unit_cost
  from public.teller_inventory_apply_issue(
    v_from.quantity_on_hand, v_from.inventory_value, v_from.weighted_average_unit_cost,
    p_quantity, v_item.allow_negative_stock
  );

  select quantity_on_hand, inventory_value, weighted_average_unit_cost
  into v_in_qty, v_in_value, v_in_wac
  from public.teller_inventory_apply_receipt(
    v_to.quantity_on_hand, v_to.inventory_value, v_to.weighted_average_unit_cost,
    p_quantity, v_unit_cost
  );

  insert into public.teller_inventory_transfer_groups (
    organization_id, inventory_item_id, from_location_id, to_location_id,
    quantity, unit_cost, extended_cost, idempotency_key, occurred_at
  )
  values (
    p_organization_id, p_inventory_item_id, p_from_location_id, p_to_location_id,
    p_quantity, v_unit_cost, v_cogs, p_idempotency_key, p_occurred_at
  )
  returning id into v_group_id;

  insert into public.teller_inventory_movements (
    organization_id, inventory_item_id, location_id, movement_type,
    quantity_delta, unit_cost, extended_cost, transfer_group_id, idempotency_key, occurred_at
  )
  values (
    p_organization_id, p_inventory_item_id, p_from_location_id, 'transfer_out',
    -p_quantity, v_unit_cost, v_cogs, v_group_id, p_idempotency_key || ':out', p_occurred_at
  )
  returning id into v_out_movement_id;

  insert into public.teller_inventory_movements (
    organization_id, inventory_item_id, location_id, movement_type,
    quantity_delta, unit_cost, extended_cost, transfer_group_id, idempotency_key, occurred_at
  )
  values (
    p_organization_id, p_inventory_item_id, p_to_location_id, 'transfer_in',
    p_quantity, v_unit_cost, v_cogs, v_group_id, p_idempotency_key || ':in', p_occurred_at
  )
  returning id into v_in_movement_id;

  update public.teller_inventory_balances
  set quantity_on_hand = v_out_qty, inventory_value = v_out_value, weighted_average_unit_cost = v_out_wac, updated_at = now()
  where id = v_from.id;

  update public.teller_inventory_balances
  set quantity_on_hand = v_in_qty, inventory_value = v_in_value, weighted_average_unit_cost = v_in_wac, updated_at = now()
  where id = v_to.id;

  return jsonb_build_object(
    'duplicate', false,
    'transfer_group_id', v_group_id,
    'out_movement_id', v_out_movement_id,
    'in_movement_id', v_in_movement_id,
    'unit_cost', v_unit_cost,
    'extended_cost', v_cogs
  );
end;
$$;

grant execute on function public.teller_atomic_transfer_inventory(
  uuid, uuid, uuid, uuid, numeric, text, timestamptz, uuid
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Atomic reverse movement
-- ---------------------------------------------------------------------------

create or replace function public.teller_atomic_reverse_inventory_movement(
  p_organization_id uuid,
  p_movement_id uuid,
  p_idempotency_key text,
  p_entry_date date default null,
  p_journal_lines jsonb default null,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_original public.teller_inventory_movements%rowtype;
  v_existing public.teller_inventory_movements%rowtype;
  v_reversal_id uuid;
  v_journal_id uuid;
  v_balance public.teller_inventory_balances%rowtype;
  v_new_qty numeric;
  v_new_value numeric;
  v_new_wac numeric;
  v_closed_through date;
begin
  if auth.uid() is not null and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to reverse inventory movement';
  end if;

  perform public.teller_acquire_org_accounting_lock(p_organization_id);

  select * into v_existing
  from public.teller_inventory_movements
  where organization_id = p_organization_id and idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object('duplicate', true, 'movement_id', v_existing.id);
  end if;

  select * into v_original
  from public.teller_inventory_movements
  where id = p_movement_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Movement not found'; end if;
  if v_original.reversed_by_movement_id is not null then
    raise exception 'Movement already reversed';
  end if;

  if p_entry_date is not null then
    v_closed_through := public.teller_books_closed_through(p_organization_id);
    if v_closed_through is not null and p_entry_date <= v_closed_through then
      raise exception 'Accounting period is closed through %', v_closed_through;
    end if;
  end if;

  v_balance := public.teller_inventory_lock_balance(
    p_organization_id, v_original.inventory_item_id, v_original.location_id
  );

  if v_original.quantity_delta > 0 then
    select quantity_on_hand, inventory_value, weighted_average_unit_cost
    into v_new_qty, v_new_value, v_new_wac
    from public.teller_inventory_apply_issue(
      v_balance.quantity_on_hand, v_balance.inventory_value, v_balance.weighted_average_unit_cost,
      v_original.quantity_delta, false
    );
  else
    select quantity_on_hand, inventory_value, weighted_average_unit_cost
    into v_new_qty, v_new_value, v_new_wac
    from public.teller_inventory_apply_receipt(
      v_balance.quantity_on_hand, v_balance.inventory_value, v_balance.weighted_average_unit_cost,
      abs(v_original.quantity_delta), v_original.unit_cost
    );
  end if;

  if p_journal_lines is not null and p_entry_date is not null then
    v_journal_id := public.teller_post_journal(
      p_organization_id,
      p_entry_date,
      'inventory reversal',
      'inventory_movement',
      p_movement_id,
      null,
      p_journal_lines
    );
  end if;

  insert into public.teller_inventory_movements (
    organization_id, inventory_item_id, location_id, movement_type,
    quantity_delta, unit_cost, extended_cost, source_type, source_id,
    job_id, vendor_id, journal_entry_id, reversal_of_movement_id, idempotency_key, occurred_at
  )
  values (
    p_organization_id, v_original.inventory_item_id, v_original.location_id, 'reversal',
    -v_original.quantity_delta, v_original.unit_cost, -v_original.extended_cost,
    v_original.source_type, v_original.source_id, v_original.job_id, v_original.vendor_id,
    v_journal_id, p_movement_id, p_idempotency_key, coalesce(p_entry_date::timestamptz, now())
  )
  returning id into v_reversal_id;

  update public.teller_inventory_movements
  set reversed_by_movement_id = v_reversal_id
  where id = p_movement_id;

  update public.teller_inventory_balances
  set quantity_on_hand = v_new_qty, inventory_value = v_new_value, weighted_average_unit_cost = v_new_wac, updated_at = now()
  where id = v_balance.id;

  return jsonb_build_object(
    'duplicate', false,
    'reversal_movement_id', v_reversal_id,
    'journal_entry_id', v_journal_id
  );
end;
$$;

grant execute on function public.teller_atomic_reverse_inventory_movement(
  uuid, uuid, text, date, jsonb, uuid
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- GRNI: org-level inventory account mappings
-- ---------------------------------------------------------------------------

create table if not exists public.teller_inventory_account_mappings (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  mapping_key text not null,
  account_id uuid not null references public.teller_accounts (id),
  is_required boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teller_inventory_account_mappings_key_check check (
    mapping_key in (
      'inventory_asset',
      'grni_liability',
      'purchase_price_variance',
      'cogs',
      'adjustment_expense',
      'adjustment_gain'
    )
  ),
  unique (organization_id, mapping_key)
);

create index if not exists teller_inventory_account_mappings_org_idx
  on public.teller_inventory_account_mappings (organization_id);

alter table public.teller_inventory_account_mappings enable row level security;

create policy "teller members read inventory account mappings"
  on public.teller_inventory_account_mappings for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage inventory account mappings"
  on public.teller_inventory_account_mappings for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- GRNI: extend Phase 6 purchase receipt lines for inventory economics
-- ---------------------------------------------------------------------------

alter table public.teller_purchase_receipt_lines
  add column if not exists inventory_item_id uuid references public.teller_inventory_items (id),
  add column if not exists inventory_location_id uuid references public.teller_inventory_locations (id),
  add column if not exists unit_cost numeric(14, 4),
  add column if not exists extended_cost numeric(14, 2),
  add column if not exists quantity_matched numeric(14, 4) not null default 0,
  add column if not exists value_matched numeric(14, 2) not null default 0,
  add column if not exists accounting_status text not null default 'pending',
  add column if not exists inventory_movement_id uuid references public.teller_inventory_movements (id),
  add column if not exists receipt_journal_entry_id uuid references public.teller_journal_entries (id),
  add column if not exists idempotency_key text,
  add column if not exists cost_source text;

alter table public.teller_purchase_receipt_lines
  drop constraint if exists teller_purchase_receipt_lines_accounting_status_check;

alter table public.teller_purchase_receipt_lines
  add constraint teller_purchase_receipt_lines_accounting_status_check check (
    accounting_status in ('pending', 'posted', 'reversed')
  );

create unique index if not exists teller_purchase_receipt_lines_org_idempotency_idx
  on public.teller_purchase_receipt_lines (organization_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists teller_purchase_receipt_lines_org_status_idx
  on public.teller_purchase_receipt_lines (organization_id, accounting_status);

-- ---------------------------------------------------------------------------
-- GRNI: receipt-to-bill settlement allocations (many-to-many)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_inventory_receipt_bill_allocations (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  receipt_line_id uuid not null references public.teller_purchase_receipt_lines (id),
  bill_line_id uuid not null references public.teller_document_lines (id),
  bill_id uuid not null references public.teller_documents (id),
  quantity_matched numeric(14, 4) not null,
  receipt_value_matched numeric(14, 2) not null,
  bill_value_matched numeric(14, 2) not null,
  variance_amount numeric(14, 2) not null default 0,
  settlement_journal_entry_id uuid references public.teller_journal_entries (id),
  reversal_of_allocation_id uuid references public.teller_inventory_receipt_bill_allocations (id),
  reversed_by_allocation_id uuid references public.teller_inventory_receipt_bill_allocations (id),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  constraint teller_inventory_receipt_bill_allocations_qty_positive check (quantity_matched > 0),
  unique (organization_id, idempotency_key)
);

create index if not exists teller_inventory_receipt_bill_alloc_org_receipt_idx
  on public.teller_inventory_receipt_bill_allocations (organization_id, receipt_line_id);

create index if not exists teller_inventory_receipt_bill_alloc_org_bill_idx
  on public.teller_inventory_receipt_bill_allocations (organization_id, bill_line_id);

create index if not exists teller_inventory_receipt_bill_alloc_org_bill_doc_idx
  on public.teller_inventory_receipt_bill_allocations (organization_id, bill_id);

alter table public.teller_inventory_receipt_bill_allocations enable row level security;

create policy "teller members read inventory receipt bill allocations"
  on public.teller_inventory_receipt_bill_allocations for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage inventory receipt bill allocations"
  on public.teller_inventory_receipt_bill_allocations for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- GRNI: atomic bill settlement (Dr GRNI / Dr|Cr PPV / Cr AP)
-- ---------------------------------------------------------------------------

create or replace function public.teller_atomic_settle_inventory_receipt_bill(
  p_organization_id uuid,
  p_receipt_line_id uuid,
  p_bill_line_id uuid,
  p_bill_id uuid,
  p_quantity_matched numeric,
  p_receipt_unit_cost numeric,
  p_bill_unit_cost numeric,
  p_idempotency_key text,
  p_entry_date date,
  p_journal_lines jsonb,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_receipt_line public.teller_purchase_receipt_lines%rowtype;
  v_existing public.teller_inventory_receipt_bill_allocations%rowtype;
  v_allocation_id uuid;
  v_journal_id uuid;
  v_receipt_value numeric;
  v_bill_value numeric;
  v_variance numeric;
  v_open_qty numeric;
  v_closed_through date;
begin
  if auth.uid() is not null and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to settle inventory receipt';
  end if;

  perform public.teller_acquire_org_accounting_lock(p_organization_id);

  v_closed_through := public.teller_books_closed_through(p_organization_id);
  if v_closed_through is not null and p_entry_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  select * into v_existing
  from public.teller_inventory_receipt_bill_allocations
  where organization_id = p_organization_id and idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object(
      'duplicate', true,
      'allocation_id', v_existing.id,
      'journal_entry_id', v_existing.settlement_journal_entry_id
    );
  end if;

  select * into v_receipt_line
  from public.teller_purchase_receipt_lines
  where id = p_receipt_line_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Receipt line not found'; end if;
  if v_receipt_line.accounting_status <> 'posted' then
    raise exception 'Receipt line must be posted before bill settlement';
  end if;

  v_open_qty := round(v_receipt_line.quantity_received - coalesce(v_receipt_line.quantity_matched, 0), 4);
  if p_quantity_matched - v_open_qty > 0.0001 then
    raise exception 'Match quantity exceeds open receipt quantity';
  end if;

  v_receipt_value := public.teller_inventory_round_money(p_quantity_matched * p_receipt_unit_cost);
  v_bill_value := public.teller_inventory_round_money(p_quantity_matched * p_bill_unit_cost);
  v_variance := public.teller_inventory_round_money(v_bill_value - v_receipt_value);

  v_journal_id := public.teller_post_journal(
    p_organization_id,
    p_entry_date,
    'GRNI bill settlement',
    'inventory_grni_settlement',
    p_bill_id,
    null,
    p_journal_lines
  );

  insert into public.teller_inventory_receipt_bill_allocations (
    organization_id, receipt_line_id, bill_line_id, bill_id,
    quantity_matched, receipt_value_matched, bill_value_matched, variance_amount,
    settlement_journal_entry_id, idempotency_key
  )
  values (
    p_organization_id, p_receipt_line_id, p_bill_line_id, p_bill_id,
    p_quantity_matched, v_receipt_value, v_bill_value, v_variance,
    v_journal_id, p_idempotency_key
  )
  returning id into v_allocation_id;

  update public.teller_purchase_receipt_lines
  set
    quantity_matched = round(coalesce(quantity_matched, 0) + p_quantity_matched, 4),
    value_matched = public.teller_inventory_round_money(coalesce(value_matched, 0) + v_receipt_value)
  where id = p_receipt_line_id;

  return jsonb_build_object(
    'duplicate', false,
    'allocation_id', v_allocation_id,
    'journal_entry_id', v_journal_id,
    'receipt_value_matched', v_receipt_value,
    'bill_value_matched', v_bill_value,
    'variance_amount', v_variance
  );
end;
$$;

grant execute on function public.teller_atomic_settle_inventory_receipt_bill(
  uuid, uuid, uuid, uuid, numeric, numeric, numeric, text, date, jsonb, uuid
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- GRNI: reverse settlement allocation
-- ---------------------------------------------------------------------------

create or replace function public.teller_atomic_reverse_inventory_receipt_bill_allocation(
  p_organization_id uuid,
  p_allocation_id uuid,
  p_idempotency_key text,
  p_entry_date date,
  p_journal_lines jsonb,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_original public.teller_inventory_receipt_bill_allocations%rowtype;
  v_existing public.teller_inventory_receipt_bill_allocations%rowtype;
  v_reversal_id uuid;
  v_journal_id uuid;
  v_closed_through date;
begin
  if auth.uid() is not null and not public.teller_can_write_books(p_organization_id) then
    raise exception 'Not authorized to reverse GRNI settlement';
  end if;

  perform public.teller_acquire_org_accounting_lock(p_organization_id);

  select * into v_existing
  from public.teller_inventory_receipt_bill_allocations
  where organization_id = p_organization_id and idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object('duplicate', true, 'allocation_id', v_existing.id);
  end if;

  select * into v_original
  from public.teller_inventory_receipt_bill_allocations
  where id = p_allocation_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Allocation not found'; end if;
  if v_original.reversed_by_allocation_id is not null then
    raise exception 'Allocation already reversed';
  end if;

  v_closed_through := public.teller_books_closed_through(p_organization_id);
  if v_closed_through is not null and p_entry_date <= v_closed_through then
    raise exception 'Accounting period is closed through %', v_closed_through;
  end if;

  v_journal_id := public.teller_post_journal(
    p_organization_id,
    p_entry_date,
    'GRNI settlement reversal',
    'inventory_grni_settlement',
    p_allocation_id,
    null,
    p_journal_lines
  );

  insert into public.teller_inventory_receipt_bill_allocations (
    organization_id, receipt_line_id, bill_line_id, bill_id,
    quantity_matched, receipt_value_matched, bill_value_matched, variance_amount,
    settlement_journal_entry_id, reversal_of_allocation_id, idempotency_key
  )
  values (
    p_organization_id, v_original.receipt_line_id, v_original.bill_line_id, v_original.bill_id,
    v_original.quantity_matched, v_original.receipt_value_matched, v_original.bill_value_matched,
    v_original.variance_amount, v_journal_id, p_allocation_id, p_idempotency_key
  )
  returning id into v_reversal_id;

  update public.teller_inventory_receipt_bill_allocations
  set reversed_by_allocation_id = v_reversal_id
  where id = p_allocation_id;

  update public.teller_purchase_receipt_lines
  set
    quantity_matched = round(greatest(0, quantity_matched - v_original.quantity_matched), 4),
    value_matched = public.teller_inventory_round_money(greatest(0, value_matched - v_original.receipt_value_matched))
  where id = v_original.receipt_line_id;

  return jsonb_build_object(
    'duplicate', false,
    'reversal_allocation_id', v_reversal_id,
    'journal_entry_id', v_journal_id
  );
end;
$$;

grant execute on function public.teller_atomic_reverse_inventory_receipt_bill_allocation(
  uuid, uuid, text, date, jsonb, uuid
) to authenticated, service_role;

-- Does NOT alter teller_post_journal signature.
