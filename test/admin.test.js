import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('admin authorization, legacy migration, order, archive/restore, deletion and stale edits', async () => {
  const db = new PGlite();
  const author = '11111111-1111-4111-8111-111111111111', admin = '22222222-2222-4222-8222-222222222222', outsider = '33333333-3333-4333-8333-333333333333';
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth; create schema storage;
      create table auth.users(id uuid primary key, email text, is_anonymous boolean default true, email_confirmed_at timestamptz);
      insert into auth.users(id) values ('${author}');
      insert into auth.users values ('${admin}', 'owner@example.test', false, now()), ('${outsider}', 'other@example.test', false, now());
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth,storage to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;
      create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects(id bigint generated always as identity primary key, bucket_id text, name text, owner_id text, unique(bucket_id,name));
      alter table storage.objects enable row level security;
      grant select,insert,update,delete on storage.objects to authenticated;
      grant usage on sequence storage.objects_id_seq to authenticated;`);
    await db.exec(await readFile(new URL('../supabase/setup.sql',import.meta.url),'utf8'));
    async function as(id, role='authenticated') { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]); await db.exec(`set role ${role}`); }
    async function state() { return (await db.query('select public.sixfps_state() as s')).rows[0].s; }
    async function publish() {
      const b = (await db.query('select public.sixfps_book() as s')).rows[0].s.booking;
      await db.query("insert into storage.objects(bucket_id,name,owner_id) values ('sixfps-frames',$1,$2)",[b.path,author]);
      return (await db.query('select public.sixfps_publish($1::uuid) as s',[b.token])).rows[0].s;
    }
    // Migrate an existing three-frame movie, not just an empty database.
    await as(author); await publish(); await publish(); await publish();
    await db.exec('reset role');
    const migration=await readFile(new URL('../supabase/admin.sql',import.meta.url),'utf8');
    await db.exec(migration); await db.exec(migration);
    await db.query('insert into public.sixfps_admins values ($1),($2)',[admin,author]);
    async function edit(action,id=null,pos=null,revision=null) {
      const rev=revision ?? (await state()).revision;
      return (await db.query('select public.sixfps_admin_edit($1,$2,$3,$4) as s',[action,id,pos,rev])).rows[0].s;
    }
    await as('','anon'); await assert.rejects(()=>edit('archive',1),/permission denied/);
    await as(author); // Even an accidentally allowlisted anonymous account is not admin.
    assert.equal((await db.query('select public.sixfps_is_admin() as ok')).rows[0].ok,false);
    await assert.rejects(()=>edit('archive',1),/Admin access required/);
    await assert.rejects(()=>db.query('insert into public.sixfps_admins values ($1)',[outsider]),/permission denied/);
    await as(outsider); await assert.rejects(()=>edit('archive',1),/Admin access required/);
    await as(admin); let movie=(await db.query('select public.sixfps_admin_state() as s')).rows[0].s;
    assert.deepEqual(movie.frames.map(f=>[f.id,f.position]),[[1,1],[2,2],[3,3]]);
    const initialRevision=movie.movie.revision;
    movie=await edit('move',3,1); assert.deepEqual(movie.frames.map(f=>f.id),[3,1,2]);
    await assert.rejects(()=>edit('move',1,1,initialRevision),/movie changed/);
    await assert.rejects(()=>edit('move',1,9),/Invalid frame position/);
    movie=await edit('archive',1); assert.equal(movie.movie.count,2);
    assert.deepEqual(movie.frames.filter(f=>!f.archived).map(f=>[f.id,f.position]),[[3,1],[2,2]]);
    await as('','anon'); assert.deepEqual((await db.query('select id from public.sixfps_frames order by position')).rows.map(r=>r.id),[3,2]);
    await as(admin); movie=await edit('restore',1); assert.equal(movie.frames.find(f=>f.id===1).position,3);
    movie=await edit('archive',3); const oldPath=movie.frames.find(f=>f.id===3).path;
    assert.equal((await db.query('delete from storage.objects where name=$1 returning id',[oldPath])).rows.length,0);
    movie=await edit('prepare_delete',3);
    await assert.rejects(()=>edit('restore',3),/cannot be restored/);
    await assert.rejects(()=>edit('finish_delete',3),/Storage first/);
    await as(author); assert.equal((await db.query('delete from storage.objects where name=$1 returning id',[oldPath])).rows.length,0);
    await as(admin); assert.equal((await db.query('delete from storage.objects where name=$1 returning id',[oldPath])).rows.length,1);
    movie=await edit('finish_delete',3); assert.equal(movie.frames.some(f=>f.id===3),false);
    await as(author); const b=(await db.query('select public.sixfps_book() as s')).rows[0].s.booking;
    await as(admin); await assert.rejects(()=>edit('archive',1),/being drawn/); await edit('release');
    await as(author); await assert.rejects(()=>db.query('select public.sixfps_publish($1::uuid)',[b.token]),/booking has ended/);
    const published=await publish(); assert.equal(published.count,3);
    await as(admin); movie=(await db.query('select public.sixfps_admin_state() as s')).rows[0].s;
    assert.equal(movie.frames.find(f=>f.position===3).id,4); // no reuse of deleted immutable IDs
    await db.exec('reset role'); await db.exec(migration); // keep order and data after rerun
    assert.equal((await state()).count,3);
    await db.query('delete from public.sixfps_admins where user_id=$1',[admin]);
    await as(admin); await assert.rejects(()=>edit('archive',1),/Admin access required/);
  } finally { await db.close(); }
});
