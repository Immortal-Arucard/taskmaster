-- Taskmaster task comments with owner-granted access.
-- NEW FILE. NOT APPLIED. Apply once, by the database owner, in the Supabase
-- SQL editor, AFTER backend/supabase/twgi_push.sql. Never apply it twice.
--
-- Model
--   taskmaster_threads        one row per task the owner opened for comments
--                             (title snapshot; the list itself stays on the device)
--   taskmaster_comment_grants owner grants comment access to a TWGI account
--                             email, for one task (task_id) or the whole list
--                             (task_id null). Deleting the row revokes access.
--   taskmaster_comments       the comments
--
-- Rules (row level security, auth.uid() and the signed-in email claim):
--   owner     reads all, adds comments, deletes ANY comment, edits own,
--             manages threads and grants
--   grantee   reads threads/comments it was granted, adds comments, and
--             edits or deletes ONLY its own comments
--   others    nothing
-- Author id, name, avatar and timestamps are set by triggers, not the browser.

begin;

create table public.taskmaster_threads (
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  task_id text not null check (char_length(task_id) between 1 and 80),
  title text not null default '' check (char_length(title) <= 140),
  owner_name text not null default '' check (char_length(owner_name) <= 80),
  archived boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (owner_id, task_id)
);

create table public.taskmaster_comment_grants (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  task_id text check (task_id is null or char_length(task_id) between 1 and 80),
  grantee_email text not null check (grantee_email = lower(btrim(grantee_email)) and grantee_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(grantee_email) <= 254),
  created_at timestamptz not null default now()
);
create unique index taskmaster_comment_grants_one on public.taskmaster_comment_grants (owner_id, coalesce(task_id, ''), grantee_email);
create index taskmaster_comment_grants_email on public.taskmaster_comment_grants (grantee_email);

create table public.taskmaster_comments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  task_id text not null,
  author_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  author_name text not null default '' check (char_length(author_name) <= 80),
  author_avatar text not null default '' check (author_avatar = '' or (author_avatar like 'https://%' and char_length(author_avatar) <= 500)),
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  foreign key (owner_id, task_id) references public.taskmaster_threads (owner_id, task_id) on delete cascade
);
create index taskmaster_comments_thread on public.taskmaster_comments (owner_id, task_id, created_at);
create index taskmaster_comments_recent on public.taskmaster_comments (created_at);

-- Signed-in email from the Supabase access token, lower-cased.
create function public.taskmaster_my_email()
returns text
language sql
stable
set search_path = ''
as $$
  select lower(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', ''));
$$;

create function public.taskmaster_can_comment(thread_owner uuid, thread_task text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and (
    auth.uid() = thread_owner
    or exists (
      select 1 from public.taskmaster_comment_grants g
      where g.owner_id = thread_owner
        and (g.task_id is null or g.task_id = thread_task)
        and g.grantee_email = public.taskmaster_my_email()
        and public.taskmaster_my_email() <> ''
    )
  );
$$;

-- Display name and avatar for the signed-in person, from the master profile
-- or the sign-in provider's metadata.
create function public.taskmaster_me()
returns table (name text, avatar text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  claims jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
  meta jsonb := coalesce(claims -> 'user_metadata', '{}'::jsonb);
  stored text;
  pic text;
begin
  begin
    execute 'select display_name from public.master_profiles where id = $1' into stored using auth.uid();
  exception when undefined_table or undefined_column then stored := null;
  end;
  name := left(coalesce(nullif(btrim(stored), ''), nullif(btrim(meta ->> 'full_name'), ''), nullif(btrim(meta ->> 'name'), ''),
    nullif(split_part(coalesce(claims ->> 'email', ''), '@', 1), ''), 'TWGI member'), 80);
  pic := coalesce(meta ->> 'avatar_url', meta ->> 'picture', '');
  avatar := case when pic like 'https://%' and char_length(pic) <= 500 then pic else '' end;
  return next;
end;
$$;

create function public.taskmaster_thread_stamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.owner_id := old.owner_id;
    new.task_id := old.task_id;
  end if;
  select me.name into new.owner_name from public.taskmaster_me() me;
  new.updated_at := now();
  return new;
end;
$$;

create trigger taskmaster_thread_stamp before insert or update on public.taskmaster_threads
for each row execute function public.taskmaster_thread_stamp();

create function public.taskmaster_grant_stamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.grantee_email := lower(btrim(new.grantee_email));
  if (select count(*) from public.taskmaster_comment_grants g where g.owner_id = new.owner_id) >= 100 then
    raise exception 'You can share with up to 100 people.';
  end if;
  return new;
end;
$$;

create trigger taskmaster_grant_stamp before insert on public.taskmaster_comment_grants
for each row execute function public.taskmaster_grant_stamp();

create function public.taskmaster_comment_stamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  me record;
begin
  if tg_op = 'INSERT' then
    select * into me from public.taskmaster_me();
    new.author_id := auth.uid();
    new.author_name := me.name;
    new.author_avatar := me.avatar;
    new.created_at := now();
    new.edited_at := null;
    if exists (select 1 from public.taskmaster_threads t where t.owner_id = new.owner_id and t.task_id = new.task_id and t.archived) then
      raise exception 'This task is closed for comments.';
    end if;
  else
    -- Only the text can change; who and when stay as first written.
    new.id := old.id;
    new.owner_id := old.owner_id;
    new.task_id := old.task_id;
    new.author_id := old.author_id;
    new.author_name := old.author_name;
    new.author_avatar := old.author_avatar;
    new.created_at := old.created_at;
    new.edited_at := now();
  end if;
  return new;
end;
$$;

create trigger taskmaster_comment_stamp before insert or update on public.taskmaster_comments
for each row execute function public.taskmaster_comment_stamp();

alter table public.taskmaster_threads enable row level security;
alter table public.taskmaster_comment_grants enable row level security;
alter table public.taskmaster_comments enable row level security;

-- Supabase default privileges give anon/authenticated ALL (incl. TRUNCATE,
-- which ignores row level security) on new public tables: strip, then grant.
revoke all on public.taskmaster_threads, public.taskmaster_comment_grants, public.taskmaster_comments from anon, authenticated, public;
grant select, insert, update, delete on public.taskmaster_threads to authenticated;
grant select, insert, delete on public.taskmaster_comment_grants to authenticated;
grant select, insert, update, delete on public.taskmaster_comments to authenticated;

create policy threads_read on public.taskmaster_threads for select to authenticated
  using (public.taskmaster_can_comment(owner_id, task_id));
create policy threads_owner_insert on public.taskmaster_threads for insert to authenticated
  with check (owner_id = auth.uid());
create policy threads_owner_update on public.taskmaster_threads for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy threads_owner_delete on public.taskmaster_threads for delete to authenticated
  using (owner_id = auth.uid());

create policy grants_read on public.taskmaster_comment_grants for select to authenticated
  using (owner_id = auth.uid() or (grantee_email = public.taskmaster_my_email() and public.taskmaster_my_email() <> ''));
create policy grants_owner_insert on public.taskmaster_comment_grants for insert to authenticated
  with check (owner_id = auth.uid());
create policy grants_owner_delete on public.taskmaster_comment_grants for delete to authenticated
  using (owner_id = auth.uid());

create policy comments_read on public.taskmaster_comments for select to authenticated
  using (public.taskmaster_can_comment(owner_id, task_id));
create policy comments_insert on public.taskmaster_comments for insert to authenticated
  with check (author_id = auth.uid() and public.taskmaster_can_comment(owner_id, task_id));
create policy comments_author_update on public.taskmaster_comments for update to authenticated
  using (author_id = auth.uid() and public.taskmaster_can_comment(owner_id, task_id))
  with check (author_id = auth.uid());
create policy comments_delete on public.taskmaster_comments for delete to authenticated
  using (author_id = auth.uid() or owner_id = auth.uid());

-- Comment push: the push Worker (role twgi_push_server) reads only recent
-- comments written by someone other than the task owner.
create function public.taskmaster_recent_comments(since timestamptz)
returns table (id uuid, owner_id uuid, task_id text, task_title text, author_name text, body text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.owner_id, c.task_id, t.title, c.author_name, left(c.body, 200), c.created_at
  from public.taskmaster_comments c
  join public.taskmaster_threads t on t.owner_id = c.owner_id and t.task_id = c.task_id
  where c.created_at > greatest(since, now() - interval '1 day')
    and c.author_id <> c.owner_id
  order by c.created_at
  limit 200;
$$;

revoke all on function public.taskmaster_recent_comments(timestamptz) from public, anon, authenticated;
revoke all on function public.taskmaster_can_comment(uuid, text) from public, anon;
revoke all on function public.taskmaster_me() from public, anon;
revoke all on function public.taskmaster_my_email() from public, anon;
revoke all on function public.taskmaster_thread_stamp(), public.taskmaster_grant_stamp(), public.taskmaster_comment_stamp() from public, anon, authenticated;
grant execute on function public.taskmaster_my_email() to authenticated;
grant execute on function public.taskmaster_can_comment(uuid, text) to authenticated;
grant execute on function public.taskmaster_me() to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'twgi_push_server') then
    grant execute on function public.taskmaster_recent_comments(timestamptz) to twgi_push_server;
  end if;
end $$;

commit;
