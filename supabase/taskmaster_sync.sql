-- Taskmaster cloud sync across devices (Taskmaster v6).
-- NEW FILE. NOT APPLIED. Apply ONCE, by the database owner, in the Supabase
-- SQL editor. Never apply it twice. It does not touch any existing table
-- (twgi_push.*, taskmaster_threads/_comment_grants/_comments are unchanged).
--
-- Model
--   taskmaster_tasks  one row per task per account. The task (name, done,
--                     times, worked sessions) is in `data`. A deleted task
--                     stays as a tombstone (deleted = true, data = {}), so an
--                     older copy on another device can never bring it back.
--   taskmaster_lists  one row per account: the manual order of the list
--                     (task_order = array of task ids, top first).
--
-- Rules
--   Owner only: each signed-in account reads and writes only its own rows
--   ((select auth.uid()) policies). Row level security is forced. No access
--   for anon. No DELETE grant: deletions are tombstones.
--   Newest wins: the trigger ignores a write whose updated_at is older than
--   the row already stored, and stamps synced_at = now() on every accepted
--   write (devices fetch "what changed since synced_at X").
--   Live updates: both tables are added to the supabase_realtime publication;
--   Realtime applies the same row level security.

begin;

create table public.taskmaster_tasks (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 80),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object' and pg_column_size(data) < 32768),
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  primary key (user_id, id),
  check (not deleted or data = '{}'::jsonb)
);
create index taskmaster_tasks_user_synced on public.taskmaster_tasks (user_id, synced_at);

create table public.taskmaster_lists (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  task_order jsonb not null default '[]'::jsonb check (jsonb_typeof(task_order) = 'array' and pg_column_size(task_order) < 65536),
  updated_at timestamptz not null default now(),
  synced_at timestamptz not null default now()
);

-- Newest-wins guard + server sync stamp (shared by both tables).
create function public.taskmaster_sync_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.updated_at < old.updated_at then
      return null; -- an older copy: keep the newer row that is already stored
    end if;
    new.user_id := old.user_id;
  end if;
  new.synced_at := now();
  return new;
end;
$$;

create trigger taskmaster_tasks_stamp before insert or update on public.taskmaster_tasks
  for each row execute function public.taskmaster_sync_stamp();
create trigger taskmaster_lists_stamp before insert or update on public.taskmaster_lists
  for each row execute function public.taskmaster_sync_stamp();

alter table public.taskmaster_tasks enable row level security;
alter table public.taskmaster_tasks force row level security;
alter table public.taskmaster_lists enable row level security;
alter table public.taskmaster_lists force row level security;

revoke all on public.taskmaster_tasks, public.taskmaster_lists from public, anon, authenticated;
grant select, insert, update on public.taskmaster_tasks, public.taskmaster_lists to authenticated;

create policy taskmaster_tasks_select_own on public.taskmaster_tasks
  for select to authenticated using (user_id = (select auth.uid()));
create policy taskmaster_tasks_insert_own on public.taskmaster_tasks
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy taskmaster_tasks_update_own on public.taskmaster_tasks
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy taskmaster_lists_select_own on public.taskmaster_lists
  for select to authenticated using (user_id = (select auth.uid()));
create policy taskmaster_lists_insert_own on public.taskmaster_lists
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy taskmaster_lists_update_own on public.taskmaster_lists
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on function public.taskmaster_sync_stamp() from public, anon, authenticated;

alter publication supabase_realtime add table public.taskmaster_tasks, public.taskmaster_lists;

commit;
