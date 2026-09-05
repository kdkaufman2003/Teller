-- Expense attachments and structured metadata (mileage, receipt classification)

alter table public.teller_documents
  add column if not exists attachment_path text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

comment on column public.teller_documents.attachment_path is
  'Supabase Storage path under receipts bucket, org-scoped prefix';
comment on column public.teller_documents.metadata is
  'Expense extras: expense_type, miles, rate_per_mile, classification, etc.';

-- Receipt storage (private per organization)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipts',
  'receipts',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "teller members read receipts" on storage.objects;
drop policy if exists "teller members upload receipts" on storage.objects;
drop policy if exists "teller members delete own receipts" on storage.objects;

create policy "teller members read receipts"
  on storage.objects for select
  using (
    bucket_id = 'receipts'
    and public.teller_is_org_member(((storage.foldername(name))[1])::uuid)
  );

create policy "teller members upload receipts"
  on storage.objects for insert
  with check (
    bucket_id = 'receipts'
    and public.teller_is_org_member(((storage.foldername(name))[1])::uuid)
  );

create policy "teller members delete own receipts"
  on storage.objects for delete
  using (
    bucket_id = 'receipts'
    and public.teller_is_org_member(((storage.foldername(name))[1])::uuid)
  );
