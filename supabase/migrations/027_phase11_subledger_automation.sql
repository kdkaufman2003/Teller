-- Phase 11: Subledger automation & periodic accounting (additive, Phase 10 compatible)
-- Local only — do not apply to production until Phase 11 acceptance.

-- ---------------------------------------------------------------------------
-- Org automation settings (privileged auto-post toggles)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_org_automation_settings (
  organization_id uuid primary key references public.teller_organizations (id) on delete cascade,
  recurring_journal_auto_post_enabled boolean not null default false,
  recurring_bill_auto_generate_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

alter table public.teller_org_automation_settings enable row level security;

create policy "teller members read org automation settings"
  on public.teller_org_automation_settings for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage org automation settings"
  on public.teller_org_automation_settings for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Unified accounting schedules (prepaid, accrual, deferred revenue)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_accounting_schedules (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  schedule_type text not null,
  status text not null default 'draft',
  name text not null,
  vendor_party_id uuid references public.teller_parties (id),
  reference text not null default '',
  memo text not null default '',
  source_document_id uuid references public.teller_documents (id),
  source_payment_id uuid references public.teller_payments (id),
  start_date date not null,
  end_date date,
  original_amount numeric(14, 2) not null check (original_amount >= 0),
  remaining_amount numeric(14, 2) not null check (remaining_amount >= 0),
  expense_account_id uuid references public.teller_accounts (id),
  prepaid_account_id uuid references public.teller_accounts (id),
  liability_account_id uuid references public.teller_accounts (id),
  revenue_account_id uuid references public.teller_accounts (id),
  frequency text not null default 'monthly',
  recognition_method text not null default 'straight_line_monthly',
  next_occurrence_date date,
  auto_reverse boolean not null default false,
  job_id uuid references public.teller_jobs (id),
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teller_accounting_schedules_type_check
    check (schedule_type in ('prepaid_expense', 'accrued_expense', 'deferred_revenue')),
  constraint teller_accounting_schedules_status_check
    check (status in ('draft', 'active', 'paused', 'completed', 'cancelled')),
  constraint teller_accounting_schedules_frequency_check
    check (frequency in ('monthly', 'quarterly', 'annually')),
  constraint teller_accounting_schedules_method_check
    check (
      recognition_method in (
        'straight_line_monthly',
        'full_month',
        'next_full_month',
        'fixed_amount'
      )
    )
);

create index if not exists teller_accounting_schedules_org_status_next_idx
  on public.teller_accounting_schedules (organization_id, status, next_occurrence_date);

create index if not exists teller_accounting_schedules_org_type_idx
  on public.teller_accounting_schedules (organization_id, schedule_type, status);

alter table public.teller_accounting_schedules enable row level security;

create policy "teller members read accounting schedules"
  on public.teller_accounting_schedules for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage accounting schedules"
  on public.teller_accounting_schedules for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Schedule occurrences (durable idempotency per schedule + date)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_schedule_occurrences (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  schedule_id uuid not null references public.teller_accounting_schedules (id) on delete cascade,
  occurrence_date date not null,
  period_end date not null,
  amount numeric(14, 2) not null check (amount >= 0),
  status text not null default 'scheduled',
  idempotency_key text not null,
  journal_entry_id uuid references public.teller_journal_entries (id),
  reversing_journal_entry_id uuid references public.teller_journal_entries (id),
  adjusting_journal_entry_id uuid references public.teller_adjusting_journal_entries (id),
  document_id uuid references public.teller_documents (id),
  failure_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  posted_at timestamptz,
  posted_by uuid references auth.users (id),
  approved_by uuid references auth.users (id),
  constraint teller_schedule_occurrences_status_check
    check (
      status in (
        'scheduled',
        'generated',
        'approved',
        'posted',
        'skipped',
        'reversed',
        'failed'
      )
    ),
  unique (organization_id, idempotency_key),
  unique (schedule_id, occurrence_date)
);

create index if not exists teller_schedule_occurrences_org_period_idx
  on public.teller_schedule_occurrences (organization_id, period_end, status);

create index if not exists teller_schedule_occurrences_schedule_idx
  on public.teller_schedule_occurrences (schedule_id, occurrence_date);

alter table public.teller_schedule_occurrences enable row level security;

create policy "teller members read schedule occurrences"
  on public.teller_schedule_occurrences for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage schedule occurrences"
  on public.teller_schedule_occurrences for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Attachments & notes (minimal, org-scoped)
-- ---------------------------------------------------------------------------

create table if not exists public.teller_schedule_attachments (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  resource_kind text not null,
  resource_id uuid not null,
  file_name text not null,
  storage_path text not null,
  content_type text not null default 'application/octet-stream',
  uploaded_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  constraint teller_schedule_attachments_kind_check
    check (
      resource_kind in (
        'accounting_schedule',
        'schedule_occurrence',
        'adjusting_journal',
        'recurring_journal_template',
        'close_checklist_item'
      )
    )
);

create index if not exists teller_schedule_attachments_org_resource_idx
  on public.teller_schedule_attachments (organization_id, resource_kind, resource_id);

alter table public.teller_schedule_attachments enable row level security;

create policy "teller members read schedule attachments"
  on public.teller_schedule_attachments for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage schedule attachments"
  on public.teller_schedule_attachments for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

create table if not exists public.teller_schedule_notes (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  resource_kind text not null,
  resource_id uuid not null,
  note_text text not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  constraint teller_schedule_notes_kind_check
    check (
      resource_kind in (
        'accounting_schedule',
        'schedule_occurrence',
        'adjusting_journal',
        'recurring_journal_template',
        'close_checklist_item'
      )
    )
);

create index if not exists teller_schedule_notes_org_resource_idx
  on public.teller_schedule_notes (organization_id, resource_kind, resource_id);

alter table public.teller_schedule_notes enable row level security;

create policy "teller members read schedule notes"
  on public.teller_schedule_notes for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage schedule notes"
  on public.teller_schedule_notes for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

-- ---------------------------------------------------------------------------
-- Recurring journal template enhancements
-- ---------------------------------------------------------------------------

alter table public.teller_recurring_journal_templates
  add column if not exists post_mode text not null default 'draft_only';

alter table public.teller_recurring_journal_templates
  drop constraint if exists teller_recurring_journal_templates_post_mode_check;

alter table public.teller_recurring_journal_templates
  add constraint teller_recurring_journal_templates_post_mode_check
  check (post_mode in ('draft_only', 'generate_for_review', 'auto_post'));

alter table public.teller_recurring_journal_templates
  add column if not exists auto_post_enabled boolean not null default false;

-- ---------------------------------------------------------------------------
-- Recurring bill template enhancements + generation runs
-- ---------------------------------------------------------------------------

alter table public.teller_recurring_bill_templates
  add column if not exists template_status text not null default 'active';

alter table public.teller_recurring_bill_templates
  drop constraint if exists teller_recurring_bill_templates_status_check;

alter table public.teller_recurring_bill_templates
  add constraint teller_recurring_bill_templates_status_check
  check (template_status in ('active', 'paused', 'terminated'));

alter table public.teller_recurring_bill_templates
  add column if not exists next_generation_date date;

alter table public.teller_recurring_bill_templates
  add column if not exists auto_generate_enabled boolean not null default false;

create table if not exists public.teller_recurring_bill_runs (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.teller_organizations (id) on delete cascade,
  template_id uuid not null references public.teller_recurring_bill_templates (id) on delete cascade,
  occurrence_date date not null,
  document_id uuid references public.teller_documents (id),
  status text not null default 'generated',
  idempotency_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint teller_recurring_bill_runs_status_check
    check (status in ('generated', 'posted', 'cancelled', 'failed')),
  unique (organization_id, idempotency_key),
  unique (template_id, occurrence_date)
);

create index if not exists teller_recurring_bill_runs_org_date_idx
  on public.teller_recurring_bill_runs (organization_id, occurrence_date);

alter table public.teller_recurring_bill_runs enable row level security;

create policy "teller members read recurring bill runs"
  on public.teller_recurring_bill_runs for select
  using (public.teller_is_org_member(organization_id));

create policy "teller writers manage recurring bill runs"
  on public.teller_recurring_bill_runs for all
  using (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  )
  with check (
    public.teller_is_org_member(organization_id)
    and public.teller_can_write_books(organization_id)
  );

comment on table public.teller_accounting_schedules is
  'Phase 11 subledger schedules — prepaid, accrual, deferred revenue recognition. GL remains canonical via teller_post_journal.';

comment on column public.teller_accounting_schedules.schedule_type is
  'prepaid_expense: Dr prepaid / Cr expense over time; accrued_expense: Dr expense / Cr accrued liability; deferred_revenue: Dr customer deposit liability / Cr revenue (uses existing deposit subtype, not invoice revenue).';
