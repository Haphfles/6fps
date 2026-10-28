-- 6FPS admin editor. Run AFTER setup.sql. Safe to rerun; keeps existing frames.
begin;
create table if not exists public.sixfps_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.sixfps_admins enable row level security;
revoke all on public.sixfps_admins from anon, authenticated;
alter table public.sixfps_movie add column if not exists revision bigint not null default 0;
alter table public.sixfps_movie add column if not exists next_frame_id integer not null default 1;
alter table public.sixfps_frames add column if not exists position integer;
alter table public.sixfps_frames add column if not exists archived boolean not null default false;
alter table public.sixfps_frames add column if not exists purging boolean not null default false;
update public.sixfps_frames set position = id where position is null and not archived;
update public.sixfps_movie set next_frame_id = greatest(next_frame_id, coalesce((select max(id) + 1 from public.sixfps_frames), 1)) where id = 1;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sixfps_frame_position_unique' and conrelid = 'public.sixfps_frames'::regclass) then
    alter table public.sixfps_frames add constraint sixfps_frame_position_unique unique(position) deferrable initially deferred;
  end if;
end $$;
grant select(position, archived) on public.sixfps_frames to anon, authenticated;
drop policy if exists "6fps published frames" on public.sixfps_frames;
create policy "6fps published frames" on public.sixfps_frames for select to anon, authenticated using (not archived);

create or replace function public.sixfps_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.sixfps_admins a join auth.users u on u.id = a.user_id
    where a.user_id = auth.uid() and u.is_anonymous is false and u.email_confirmed_at is not null);
$$;

create or replace function public.sixfps_state()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('count', m.frame_count, 'revision', m.revision,
    'booking', (select jsonb_build_object('mine', coalesce(b.owner = auth.uid(), false),
      'expiresAt', floor(extract(epoch from b.expires_at) * 1000),
      'token', case when b.owner = auth.uid() then b.token else null end,
      'path', case when b.owner = auth.uid() then b.owner::text || '/' || b.token::text || '.png' else null end
    ) from public.sixfps_booking b where b.id = 1 and b.expires_at > now())
  ) from public.sixfps_movie m where m.id = 1;
$$;

create or replace function public.sixfps_publish(booking_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.sixfps_booking%rowtype; m public.sixfps_movie%rowtype; expected_path text; uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in before publishing.'; end if;
  select * into m from public.sixfps_movie where id = 1 for update;
  if exists (select 1 from public.sixfps_frames f where f.booking_token = sixfps_publish.booking_token and f.author = uid) then return public.sixfps_state(); end if;
  select * into b from public.sixfps_booking where id = 1;
  if not found or b.owner <> uid or b.token <> booking_token or b.expires_at <= now() then raise exception 'Your booking has ended. Book a frame again.'; end if;
  expected_path := uid::text || '/' || b.token::text || '.png';
  if not exists (select 1 from storage.objects o where o.bucket_id = 'sixfps-frames' and o.name = expected_path and o.owner_id = uid::text) then raise exception 'Upload your drawing before publishing.'; end if;
  insert into public.sixfps_frames(id, position, object_path, booking_token, author)
    values (m.next_frame_id, m.frame_count + 1, expected_path, b.token, uid);
  update public.sixfps_movie set frame_count = frame_count + 1, next_frame_id = next_frame_id + 1, revision = revision + 1 where id = 1;
  delete from public.sixfps_booking where id = 1;
  return public.sixfps_state();
end;
$$;

create or replace function public.sixfps_admin_state()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.sixfps_is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  return jsonb_build_object('movie', public.sixfps_state(),
    'frames', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'position', f.position,
      'path', f.object_path, 'archived', f.archived, 'purging', f.purging, 'createdAt', f.created_at)
      order by f.archived, f.position nulls last, f.id) from public.sixfps_frames f), '[]'::jsonb));
end;
$$;

create or replace function public.sixfps_admin_edit(action text, frame_id integer, target_position integer, expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.sixfps_movie%rowtype; f public.sixfps_frames%rowtype;
begin
  if not public.sixfps_is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  select * into m from public.sixfps_movie where id = 1 for update;
  if expected_revision is null or m.revision <> expected_revision then raise exception 'The movie changed. Refresh and try again.'; end if;
  if action = 'release' then
    delete from public.sixfps_booking where id = 1;
    update public.sixfps_movie set revision = revision + 1 where id = 1;
    return public.sixfps_admin_state();
  end if;
  -- Reordering while someone draws could invalidate their previous-frame overlay.
  if exists (select 1 from public.sixfps_booking where id = 1 and expires_at > now()) then
    raise exception 'A frame is being drawn. Wait for it to finish or release the booking first.';
  end if;
  select * into f from public.sixfps_frames where id = frame_id;
  if not found then raise exception 'Frame not found. Refresh the editor.'; end if;
  if action = 'move' then
    if f.archived or target_position is null or target_position < 1 or target_position > m.frame_count then raise exception 'Invalid frame position.'; end if;
    if target_position < f.position then
      update public.sixfps_frames set position = position + 1 where not archived and position >= target_position and position < f.position;
    else
      update public.sixfps_frames set position = position - 1 where not archived and position > f.position and position <= target_position;
    end if;
    update public.sixfps_frames set position = target_position where id = frame_id;
  elsif action = 'archive' then
    if f.archived then raise exception 'Frame is already archived.'; end if;
    update public.sixfps_frames set archived = true, position = null where id = frame_id;
    update public.sixfps_frames set position = position - 1 where not archived and position > f.position;
    update public.sixfps_movie set frame_count = frame_count - 1 where id = 1;
  elsif action = 'restore' then
    if not f.archived or f.purging then raise exception 'This frame cannot be restored.'; end if;
    update public.sixfps_frames set archived = false, position = m.frame_count + 1 where id = frame_id;
    update public.sixfps_movie set frame_count = frame_count + 1 where id = 1;
  elsif action = 'prepare_delete' then
    if not f.archived then raise exception 'Archive the frame before deleting it.'; end if;
    update public.sixfps_frames set purging = true where id = frame_id;
  elsif action = 'finish_delete' then
    if not f.archived or not f.purging then raise exception 'Deletion was not prepared.'; end if;
    if exists (select 1 from storage.objects where bucket_id = 'sixfps-frames' and name = f.object_path) then raise exception 'Remove the image through Storage first.'; end if;
    delete from public.sixfps_frames where id = frame_id;
  else raise exception 'Unknown editor action.';
  end if;
  update public.sixfps_movie set revision = revision + 1 where id = 1;
  return public.sixfps_admin_state();
end;
$$;

-- Storage deletion is only allowed after the admin has locked an archived frame for deletion.
create or replace function public.sixfps_can_delete(object_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.sixfps_is_admin() and exists (select 1 from public.sixfps_frames
    where object_path = object_name and archived and purging);
$$;
drop policy if exists "6fps admin inspect deletions" on storage.objects;
create policy "6fps admin inspect deletions" on storage.objects for select to authenticated
  using (bucket_id = 'sixfps-frames' and public.sixfps_can_delete(name));
drop policy if exists "6fps admin delete archived images" on storage.objects;
create policy "6fps admin delete archived images" on storage.objects for delete to authenticated
  using (bucket_id = 'sixfps-frames' and public.sixfps_can_delete(name));

revoke all on function public.sixfps_is_admin(), public.sixfps_admin_state(), public.sixfps_admin_edit(text,integer,integer,bigint), public.sixfps_can_delete(text) from public, anon, authenticated;
grant execute on function public.sixfps_is_admin(), public.sixfps_admin_state(), public.sixfps_admin_edit(text,integer,integer,bigint), public.sixfps_can_delete(text) to authenticated;
revoke all on function public.sixfps_state() from public;
revoke all on function public.sixfps_publish(uuid) from public, anon;
grant execute on function public.sixfps_state() to anon, authenticated;
grant execute on function public.sixfps_publish(uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
