-- 6FPS projects / live draft upgrade. Requires setup.sql and admin.sql already run.
-- On FIRST run only, archives the current movie's drawings as requested.
-- Existing files and admin accounts are preserved. Reruns do not clear new work.
begin;
create table if not exists public.sixfps_migrations(name text primary key);
alter table public.sixfps_migrations enable row level security;
revoke all on public.sixfps_migrations from anon,authenticated;

alter table public.sixfps_movie drop constraint if exists sixfps_movie_id_check;
create sequence if not exists public.sixfps_project_ids;
alter table public.sixfps_movie alter column id set default nextval('public.sixfps_project_ids');
select setval('public.sixfps_project_ids', greatest(1,(select max(id) from public.sixfps_movie)),true);
alter table public.sixfps_movie add column if not exists name text not null default 'Movie 01';
alter table public.sixfps_movie add column if not exists created_at timestamptz not null default now();
alter table public.sixfps_frames add column if not exists project_id integer not null default 1 references public.sixfps_movie(id);
alter table public.sixfps_frames drop constraint if exists sixfps_frame_position_unique;
do $$ begin
 if not exists(select 1 from pg_constraint where conname='sixfps_project_position_unique' and conrelid='public.sixfps_frames'::regclass) then
  alter table public.sixfps_frames add constraint sixfps_project_position_unique unique(project_id,position) deferrable initially deferred;
 end if;
end $$;
create sequence if not exists public.sixfps_frame_ids;
select setval('public.sixfps_frame_ids',greatest((select last_value + case when is_called then 1 else 0 end from public.sixfps_frame_ids),coalesce((select max(id)+1 from public.sixfps_frames),1),coalesce((select max(next_frame_id) from public.sixfps_movie),1)),false);

alter table public.sixfps_booking add column if not exists project_id integer not null default 1 references public.sixfps_movie(id);
alter table public.sixfps_booking drop constraint if exists sixfps_booking_id_check;
-- The existing id column becomes the reserved frame slot (1..90) inside a movie.
do $$ begin
 if not exists(select 1 from pg_constraint where conname='sixfps_booking_project_slot' and conrelid='public.sixfps_booking'::regclass) then
  alter table public.sixfps_booking drop constraint sixfps_booking_pkey;
  alter table public.sixfps_booking add constraint sixfps_booking_project_slot primary key(project_id,id);
  alter table public.sixfps_booking add constraint sixfps_booking_slot_range check(id between 1 and 90);
  alter table public.sixfps_booking add constraint sixfps_booking_one_turn unique(project_id,owner);
 end if;
end $$;

create table if not exists public.sixfps_drafts (
 project_id integer not null, slot integer not null,
 image text not null check(length(image)<=200000 and image ~ '^data:image/png;base64,[A-Za-z0-9+/]+={0,2}$'),
 expires_at timestamptz not null, updated_at timestamptz not null default now(),
 primary key(project_id,slot),
 foreign key(project_id,slot) references public.sixfps_booking(project_id,id) on delete cascade
);
alter table public.sixfps_drafts enable row level security;
revoke all on public.sixfps_drafts from anon,authenticated;
grant select on public.sixfps_drafts to anon,authenticated;
drop policy if exists "6fps live previews" on public.sixfps_drafts;
create policy "6fps live previews" on public.sixfps_drafts for select to anon,authenticated using(expires_at>now());
grant select on public.sixfps_movie to anon,authenticated;
drop policy if exists "6fps movie list" on public.sixfps_movie;
create policy "6fps movie list" on public.sixfps_movie for select to anon,authenticated using(true);
grant select(project_id) on public.sixfps_frames to anon,authenticated;

-- Clear the original movie ONCE, preserving all drawings in its admin Archive.
do $$ begin
 if not exists(select 1 from public.sixfps_migrations where name='projects-v2') then
  delete from public.sixfps_booking where project_id=1;
  update public.sixfps_frames set archived=true,position=null where project_id=1;
  update public.sixfps_movie set frame_count=0,revision=revision+1 where id=1;
  insert into public.sixfps_migrations values('projects-v2');
 end if;
end $$;

create or replace function public.sixfps_project_state(p_project integer)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',m.id,'name',m.name,'count',m.frame_count,'limit',90,'revision',m.revision,'complete',m.frame_count>=90,
  'booking',(select jsonb_build_object('mine',true,'slot',b.id,'token',b.token,'expiresAt',floor(extract(epoch from b.expires_at)*1000),'path',b.owner::text||'/'||b.token::text||'.png') from public.sixfps_booking b where b.project_id=m.id and b.owner=auth.uid() and b.expires_at>now()),
  'frames',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'slot',f.position,'path',f.object_path) order by f.position) from public.sixfps_frames f where f.project_id=m.id and not f.archived),'[]'::jsonb),
  'reservations',coalesce((select jsonb_agg(jsonb_build_object('slot',b.id,'expiresAt',floor(extract(epoch from b.expires_at)*1000)) order by b.id) from public.sixfps_booking b where b.project_id=m.id and b.expires_at>now()),'[]'::jsonb)
 ) from public.sixfps_movie m where m.id=p_project;
$$;

create or replace function public.sixfps_project_book(p_project integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.sixfps_movie%rowtype; b public.sixfps_booking%rowtype; next_slot integer; uid uuid:=auth.uid();
begin
 if uid is null then raise exception 'Sign in before booking.'; end if;
 select * into m from public.sixfps_movie where id=p_project for update;
 if not found then raise exception 'Movie not found.'; end if;
 delete from public.sixfps_booking where project_id=p_project and expires_at<=now();
 select * into b from public.sixfps_booking where project_id=p_project and owner=uid;
 if found then
  update public.sixfps_booking set expires_at=now()+interval '10 minutes' where project_id=p_project and id=b.id;
  update public.sixfps_drafts set expires_at=now()+interval '10 minutes' where project_id=p_project and slot=b.id;
 else
  if m.frame_count>=90 then raise exception 'This movie is complete: 90 frames / 15 seconds.'; end if;
  select s into next_slot from generate_series(1,90) s where
   not exists(select 1 from public.sixfps_frames f where f.project_id=p_project and not f.archived and f.position=s)
   and not exists(select 1 from public.sixfps_booking x where x.project_id=p_project and x.id=s)
   order by s limit 1;
  if next_slot is null then raise exception 'Every remaining frame is booked. Try another movie or wait for a turn to expire.'; end if;
  insert into public.sixfps_booking(id,project_id,owner,token,expires_at) values(next_slot,p_project,uid,gen_random_uuid(),now()+interval '10 minutes');
 end if;
 update public.sixfps_movie set revision=revision+1 where id=p_project;
 return public.sixfps_project_state(p_project);
end;
$$;

create or replace function public.sixfps_project_release(p_project integer,p_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.sixfps_movie where id=p_project for update;
 delete from public.sixfps_booking where project_id=p_project and owner=auth.uid() and token=p_token;
 if not found then raise exception 'This booking is no longer yours.'; end if;
 update public.sixfps_movie set revision=revision+1 where id=p_project;
 return public.sixfps_project_state(p_project);
end;
$$;

create or replace function public.sixfps_project_draft(p_project integer,p_token uuid,p_image text)
returns void language plpgsql security definer set search_path='' as $$
declare b public.sixfps_booking%rowtype;
begin
 -- Lock the booking so expiry/reassignment or publication cannot race a preview write.
 select * into b from public.sixfps_booking where project_id=p_project and owner=auth.uid() and token=p_token and expires_at>now() for update;
 if not found then raise exception 'Your booking has ended.'; end if;
 if length(p_image)>200000 or p_image !~ '^data:image/png;base64,[A-Za-z0-9+/]+={0,2}$' then raise exception 'Invalid preview.'; end if;
 if exists(select 1 from public.sixfps_drafts where project_id=p_project and slot=b.id and updated_at>now()-interval '500 milliseconds') then return; end if;
 insert into public.sixfps_drafts(project_id,slot,image,expires_at,updated_at) values(p_project,b.id,p_image,b.expires_at,now())
 on conflict(project_id,slot) do update set image=excluded.image,expires_at=excluded.expires_at,updated_at=excluded.updated_at;
end;
$$;

create or replace function public.sixfps_project_upload(object_name text)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.sixfps_booking b where b.owner=auth.uid() and b.expires_at>now() and object_name=b.owner::text||'/'||b.token::text||'.png');
$$;
drop policy if exists "6fps upload reserved frame" on storage.objects;
create policy "6fps upload reserved frame" on storage.objects for insert to authenticated
 with check(bucket_id='sixfps-frames' and public.sixfps_project_upload(name));

create or replace function public.sixfps_project_publish(p_project integer,p_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.sixfps_booking%rowtype; m public.sixfps_movie%rowtype; expected_path text; uid uuid:=auth.uid();
begin
 if uid is null then raise exception 'Sign in before publishing.'; end if;
 select * into m from public.sixfps_movie where id=p_project for update;
 if not found then raise exception 'Movie not found.'; end if;
 if exists(select 1 from public.sixfps_frames f where f.project_id=p_project and f.booking_token=p_token and f.author=uid) then return public.sixfps_project_state(p_project); end if;
 select * into b from public.sixfps_booking where project_id=p_project and token=p_token and owner=uid and expires_at>now();
 if not found then raise exception 'Your booking has ended. Book a frame again.'; end if;
 if m.frame_count>=90 then raise exception 'This movie is complete.'; end if;
 expected_path:=uid::text||'/'||b.token::text||'.png';
 if not exists(select 1 from storage.objects where bucket_id='sixfps-frames' and name=expected_path and owner_id=uid::text) then raise exception 'Upload your drawing first.'; end if;
 insert into public.sixfps_frames(id,project_id,position,object_path,booking_token,author) values(nextval('public.sixfps_frame_ids'),p_project,b.id,expected_path,b.token,uid);
 delete from public.sixfps_booking where project_id=p_project and token=p_token;
 update public.sixfps_movie set frame_count=frame_count+1,revision=revision+1 where id=p_project;
 return public.sixfps_project_state(p_project);
end;
$$;

create or replace function public.sixfps_project_admin_state(p_project integer)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not public.sixfps_is_admin() then raise exception 'Admin access required.' using errcode='42501'; end if;
 return jsonb_build_object('movie',public.sixfps_project_state(p_project),'frames',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'position',f.position,'path',f.object_path,'archived',f.archived,'purging',f.purging,'createdAt',f.created_at) order by f.archived,f.position nulls last,f.id) from public.sixfps_frames f where f.project_id=p_project),'[]'::jsonb));
end;
$$;

create or replace function public.sixfps_project_create(p_name text)
returns integer language plpgsql security definer set search_path='' as $$
declare result integer;
begin
 if not public.sixfps_is_admin() then raise exception 'Admin access required.' using errcode='42501'; end if;
 if p_name is null or length(trim(p_name)) not between 1 and 60 then raise exception 'Use a movie name of 1–60 characters.'; end if;
 insert into public.sixfps_movie(name) values(trim(p_name)) returning id into result;
 return result;
end;
$$;

create or replace function public.sixfps_project_edit(p_project integer,action text,frame_id integer,target_position integer,expected_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.sixfps_movie%rowtype; f public.sixfps_frames%rowtype; next_slot integer;
begin
 if not public.sixfps_is_admin() then raise exception 'Admin access required.' using errcode='42501'; end if;
 select * into m from public.sixfps_movie where id=p_project for update;
 if not found or expected_revision is null or m.revision<>expected_revision then raise exception 'The movie changed. Refresh and try again.'; end if;
 if action='release' then
  delete from public.sixfps_booking where project_id=p_project;
 elsif action='clear' then
  delete from public.sixfps_booking where project_id=p_project;
  update public.sixfps_frames set archived=true,position=null where project_id=p_project and not archived;
  update public.sixfps_movie set frame_count=0 where id=p_project;
 else
  if exists(select 1 from public.sixfps_booking where project_id=p_project and expires_at>now()) then raise exception 'Frames are being drawn. Wait or release bookings first.'; end if;
  delete from public.sixfps_booking where project_id=p_project and expires_at<=now();
  select * into f from public.sixfps_frames where id=frame_id and project_id=p_project;
  if not found then raise exception 'Frame not found.'; end if;
  if action='move' then
   if f.archived or target_position is null or target_position<1 or target_position>90 then raise exception 'Invalid frame position.'; end if;
   -- Swap with an occupied slot, or move into an empty one. Slot numbers remain 1..90.
   update public.sixfps_frames set position=f.position where project_id=p_project and not archived and position=target_position and id<>frame_id;
   update public.sixfps_frames set position=target_position where id=frame_id;
  elsif action='archive' then
   if f.archived then raise exception 'Frame is already archived.'; end if;
   update public.sixfps_frames set archived=true,position=null where id=frame_id;
   update public.sixfps_movie set frame_count=frame_count-1 where id=p_project;
  elsif action='restore' then
   if not f.archived or f.purging then raise exception 'This frame cannot be restored.'; end if;
   if m.frame_count>=90 then raise exception 'This movie already has 90 frames.'; end if;
   select s into next_slot from generate_series(1,90) s where not exists(select 1 from public.sixfps_frames x where x.project_id=p_project and not x.archived and x.position=s) order by s limit 1;
   update public.sixfps_frames set archived=false,position=next_slot where id=frame_id;
   update public.sixfps_movie set frame_count=frame_count+1 where id=p_project;
  elsif action='prepare_delete' then
   if not f.archived then raise exception 'Archive the frame first.'; end if;
   update public.sixfps_frames set purging=true where id=frame_id;
  elsif action='finish_delete' then
   if not f.archived or not f.purging then raise exception 'Deletion was not prepared.'; end if;
   if exists(select 1 from storage.objects where bucket_id='sixfps-frames' and name=f.object_path) then raise exception 'Remove the image through Storage first.'; end if;
   delete from public.sixfps_frames where id=frame_id;
  else raise exception 'Unknown editor action.';
  end if;
 end if;
 update public.sixfps_movie set revision=revision+1 where id=p_project;
 return public.sixfps_project_admin_state(p_project);
end;
$$;

-- Retire old single-movie mutation endpoints so older browser tabs cannot bypass the cap.
revoke execute on function public.sixfps_book(),public.sixfps_release(uuid),public.sixfps_publish(uuid),public.sixfps_admin_edit(text,integer,integer,bigint),public.sixfps_state(),public.sixfps_admin_state() from public,anon,authenticated;
revoke all on function public.sixfps_project_state(integer),public.sixfps_project_book(integer),public.sixfps_project_release(integer,uuid),public.sixfps_project_draft(integer,uuid,text),public.sixfps_project_upload(text),public.sixfps_project_publish(integer,uuid),public.sixfps_project_admin_state(integer),public.sixfps_project_create(text),public.sixfps_project_edit(integer,text,integer,integer,bigint) from public,anon,authenticated;
grant execute on function public.sixfps_project_state(integer) to anon,authenticated;
grant execute on function public.sixfps_project_book(integer),public.sixfps_project_release(integer,uuid),public.sixfps_project_draft(integer,uuid,text),public.sixfps_project_upload(text),public.sixfps_project_publish(integer,uuid),public.sixfps_project_admin_state(integer),public.sixfps_project_create(text),public.sixfps_project_edit(integer,text,integer,integer,bigint) to authenticated;

-- Enable database-change subscriptions without dropping any existing publication.
do $$ begin
 if not exists(select 1 from pg_publication where pubname='supabase_realtime') then create publication supabase_realtime; end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='sixfps_drafts') then alter publication supabase_realtime add table public.sixfps_drafts; end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='sixfps_movie') then alter publication supabase_realtime add table public.sixfps_movie; end if;
end $$;
notify pgrst,'reload schema';
commit;
