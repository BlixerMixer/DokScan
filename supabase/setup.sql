-- DokScan: database setup for accounts & cloud sync.
-- Run this once in your Supabase project: SQL Editor → New query → paste → Run.
-- Safe to run again.

-- 1. Documents table: one row per document, owned by one user.
create table if not exists public.documents (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null default 'Untitled',
  created    bigint not null,
  updated    bigint not null,
  thumb      text,
  has_image  boolean not null default false,
  data       jsonb not null
);
create index if not exists documents_user_updated on public.documents (user_id, updated desc);

-- Signed-in users may use the table (newer projects don't grant this automatically);
-- the row-level security rules below still limit each person to their own rows.
grant select, insert, update, delete on public.documents to authenticated;
revoke all on public.documents from anon;

-- Row Level Security: every person can only see and change their own rows.
alter table public.documents enable row level security;

drop policy if exists "documents: read own"   on public.documents;
drop policy if exists "documents: insert own" on public.documents;
drop policy if exists "documents: update own" on public.documents;
drop policy if exists "documents: delete own" on public.documents;

create policy "documents: read own"   on public.documents for select to authenticated using (auth.uid() = user_id);
create policy "documents: insert own" on public.documents for insert to authenticated with check (auth.uid() = user_id);
create policy "documents: update own" on public.documents for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "documents: delete own" on public.documents for delete to authenticated using (auth.uid() = user_id);

-- 2. Private file bucket for the scanned page images, one folder per user.
insert into storage.buckets (id, name, public)
values ('scans', 'scans', false)
on conflict (id) do nothing;

drop policy if exists "scans: read own"   on storage.objects;
drop policy if exists "scans: insert own" on storage.objects;
drop policy if exists "scans: update own" on storage.objects;
drop policy if exists "scans: delete own" on storage.objects;

create policy "scans: read own" on storage.objects for select to authenticated
  using (bucket_id = 'scans' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "scans: insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'scans' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "scans: update own" on storage.objects for update to authenticated
  using (bucket_id = 'scans' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "scans: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'scans' and (storage.foldername(name))[1] = auth.uid()::text);
