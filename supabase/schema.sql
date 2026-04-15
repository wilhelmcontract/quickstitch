-- Stitch Estimator schema
-- Run this in the Supabase SQL editor for your project.
-- Safe to re-run: uses `if not exists` / `create or replace` where possible.

-- =========================================================
-- projects table
-- =========================================================
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  storage_path text not null,
  stitch_count integer,
  grid_w integer,
  grid_h integer,
  created_at timestamptz not null default now()
);

create index if not exists projects_user_id_created_at_idx
  on public.projects (user_id, created_at desc);

alter table public.projects enable row level security;

-- Drop + recreate policies so re-running this script stays idempotent.
drop policy if exists "projects_select_own" on public.projects;
drop policy if exists "projects_insert_own" on public.projects;
drop policy if exists "projects_update_own" on public.projects;
drop policy if exists "projects_delete_own" on public.projects;

create policy "projects_select_own"
  on public.projects for select
  using (auth.uid() = user_id);

create policy "projects_insert_own"
  on public.projects for insert
  with check (auth.uid() = user_id);

create policy "projects_update_own"
  on public.projects for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "projects_delete_own"
  on public.projects for delete
  using (auth.uid() = user_id);

-- =========================================================
-- storage bucket: art
-- Private bucket. Files are stored under `<user_id>/<uuid>.<ext>`.
-- =========================================================
insert into storage.buckets (id, name, public)
values ('art', 'art', false)
on conflict (id) do nothing;

drop policy if exists "art_select_own" on storage.objects;
drop policy if exists "art_insert_own" on storage.objects;
drop policy if exists "art_update_own" on storage.objects;
drop policy if exists "art_delete_own" on storage.objects;

create policy "art_select_own"
  on storage.objects for select
  using (
    bucket_id = 'art'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "art_insert_own"
  on storage.objects for insert
  with check (
    bucket_id = 'art'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "art_update_own"
  on storage.objects for update
  using (
    bucket_id = 'art'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "art_delete_own"
  on storage.objects for delete
  using (
    bucket_id = 'art'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
