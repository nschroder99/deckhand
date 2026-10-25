-- Deckhand sync schema. Run once in the Supabase SQL editor of the Deckhand project.
-- One table mirrors every synced IndexedDB store; each row belongs to exactly one signed-in user.

create sequence if not exists public.objects_seq;

create table if not exists public.objects (
  user_id  uuid    not null default auth.uid() references auth.users on delete cascade,
  store    text    not null check (store in ('decks','deckConfigs','notetypes','notes','cards','revlog','media')),
  id       text    not null,
  data     jsonb,
  mtime    bigint  not null,              -- client edit time (ms); newer wins
  deleted  boolean not null default false,
  seq      bigint  not null default nextval('public.objects_seq'),  -- pull cursor
  primary key (user_id, store, id)
);
create index if not exists objects_user_seq on public.objects (user_id, seq);

-- Last write wins: an older edit never overwrites a newer one, and every accepted write moves to the end of the pull order.
create or replace function public.objects_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.mtime < old.mtime then
    return null;
  end if;
  new.user_id := old.user_id;
  new.seq := nextval('public.objects_seq');
  return new;
end $$;
drop trigger if exists objects_touch on public.objects;
create trigger objects_touch before update on public.objects for each row execute function public.objects_touch();

-- Row-level security: signed-in users see and write only their own rows. Anonymous visitors get nothing.
alter table public.objects enable row level security;
drop policy if exists "own rows" on public.objects;
create policy "own rows" on public.objects for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.objects from anon, public;
grant select, insert, update, delete on public.objects to authenticated;
revoke all on sequence public.objects_seq from anon, public;
grant usage on sequence public.objects_seq to authenticated;

-- Media bucket: private; files live under <user id>/<sha1>.
insert into storage.buckets (id, name, public, file_size_limit)
values ('media', 'media', false, 52428800)
on conflict (id) do update set public = false;

drop policy if exists "media own read" on storage.objects;
drop policy if exists "media own write" on storage.objects;
drop policy if exists "media own update" on storage.objects;
drop policy if exists "media own delete" on storage.objects;
create policy "media own read" on storage.objects for select to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "media own write" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "media own update" on storage.objects for update to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "media own delete" on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
