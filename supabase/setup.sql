-- 6FPS: run this entire file once in your Supabase project's SQL Editor.
-- Safe to rerun: existing published frames are not removed.
begin;

create table if not exists public.sixfps_movie (
  id integer primary key check (id = 1),
  frame_count integer not null default 0 check (frame_count >= 0)
);
insert into public.sixfps_movie(id) values (1) on conflict do nothing;
create table if not exists public.sixfps_booking (
  id integer primary key check (id = 1),
  owner uuid not null references auth.users(id) on delete cascade,
  token uuid not null unique,
  expires_at timestamptz not null
);
create table if not exists public.sixfps_frames (
  id integer primary key check (id > 0),
  object_path text not null unique,
  booking_token uuid not null unique,
  author uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.sixfps_movie enable row level security;
alter table public.sixfps_booking enable row level security;
alter table public.sixfps_frames enable row level security;
revoke all on public.sixfps_movie, public.sixfps_booking, public.sixfps_frames from anon, authenticated;
grant usage on schema public to anon, authenticated;
-- Frame metadata is public; ownership and reservation tokens aren't exposed.
grant select (id, object_path, created_at) on public.sixfps_frames to anon, authenticated;
drop policy if exists "6fps published frames" on public.sixfps_frames;
create policy "6fps published frames" on public.sixfps_frames for select to anon, authenticated using (true);

create or replace function public.sixfps_state()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'count', m.frame_count,
    'booking', (select jsonb_build_object(
      'mine', coalesce(b.owner = auth.uid(), false),
      'expiresAt', floor(extract(epoch from b.expires_at) * 1000),
      'token', case when b.owner = auth.uid() then b.token else null end,
      'path', case when b.owner = auth.uid() then b.owner::text || '/' || b.token::text || '.png' else null end
    ) from public.sixfps_booking b where b.id = 1 and b.expires_at > now())
  ) from public.sixfps_movie m where m.id = 1;
$$;

create or replace function public.sixfps_book()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.sixfps_booking%rowtype; uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in before booking a frame.'; end if;
  -- Every mutation locks this same row: two simultaneous bookings cannot win.
  perform 1 from public.sixfps_movie where id = 1 for update;
  select * into b from public.sixfps_booking where id = 1;
  if found and b.expires_at > now() then
    if b.owner <> uid then raise exception 'This frame is already booked.'; end if;
    update public.sixfps_booking set expires_at = now() + interval '10 minutes' where id = 1;
  else
    insert into public.sixfps_booking(id, owner, token, expires_at)
      values (1, uid, gen_random_uuid(), now() + interval '10 minutes')
      on conflict (id) do update set owner = excluded.owner, token = excluded.token, expires_at = excluded.expires_at;
  end if;
  return public.sixfps_state();
end;
$$;

create or replace function public.sixfps_release(booking_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.sixfps_movie where id = 1 for update;
  delete from public.sixfps_booking where id = 1 and owner = auth.uid() and token = booking_token;
  if not found then raise exception 'This booking is no longer yours.'; end if;
  return public.sixfps_state();
end;
$$;

-- This helper exposes only a yes/no answer about the caller's active booking.
create or replace function public.sixfps_can_upload(object_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.sixfps_booking b
    where b.id = 1 and b.owner = auth.uid() and b.expires_at > now()
      and object_name = b.owner::text || '/' || b.token::text || '.png');
$$;

create or replace function public.sixfps_publish(booking_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.sixfps_booking%rowtype; next_id integer; expected_path text; uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in before publishing.'; end if;
  select frame_count + 1 into next_id from public.sixfps_movie where id = 1 for update;
  -- A retry after a lost HTTP response must not add a duplicate frame.
  if exists (select 1 from public.sixfps_frames f where f.booking_token = sixfps_publish.booking_token and f.author = uid) then
    return public.sixfps_state();
  end if;
  select * into b from public.sixfps_booking where id = 1;
  if not found or b.owner <> uid or b.token <> booking_token or b.expires_at <= now() then
    raise exception 'Your booking has ended. Book a frame again.';
  end if;
  expected_path := uid::text || '/' || b.token::text || '.png';
  if not exists (select 1 from storage.objects o where o.bucket_id = 'sixfps-frames' and o.name = expected_path and o.owner_id = uid::text) then
    raise exception 'Upload your drawing before publishing.';
  end if;
  insert into public.sixfps_frames(id, object_path, booking_token, author)
    values (next_id, expected_path, b.token, uid);
  update public.sixfps_movie set frame_count = next_id where id = 1;
  delete from public.sixfps_booking where id = 1;
  return public.sixfps_state();
end;
$$;

-- Functions are executable by PUBLIC by default; explicitly narrow access.
revoke all on function public.sixfps_state() from public, anon, authenticated;
revoke all on function public.sixfps_book() from public, anon, authenticated;
revoke all on function public.sixfps_release(uuid) from public, anon, authenticated;
revoke all on function public.sixfps_publish(uuid) from public, anon, authenticated;
revoke all on function public.sixfps_can_upload(text) from public, anon, authenticated;
grant execute on function public.sixfps_state() to anon, authenticated;
grant execute on function public.sixfps_book(), public.sixfps_release(uuid), public.sixfps_publish(uuid), public.sixfps_can_upload(text) to authenticated;

-- Public viewing is intentional: this is the public community film.
-- PNG uploads only, at most 2 MiB each. No client may overwrite or delete art.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('sixfps-frames', 'sixfps-frames', true, 2097152, array['image/png'])
on conflict (id) do update set public = true, file_size_limit = 2097152, allowed_mime_types = array['image/png'];
drop policy if exists "6fps upload reserved frame" on storage.objects;
create policy "6fps upload reserved frame" on storage.objects for insert to authenticated
  with check (bucket_id = 'sixfps-frames' and public.sixfps_can_upload(name));
notify pgrst, 'reload schema';
commit;
