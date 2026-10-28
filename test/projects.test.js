import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('projects: reservations, live previews, ownership, 90-frame cap, admin isolation and reruns', async () => {
 const db=new PGlite();
 const author='11111111-1111-4111-8111-111111111111', admin='22222222-2222-4222-8222-222222222222', outsider='33333333-3333-4333-8333-333333333333';
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

 await as(author); await publish();
 await db.exec('reset role');
 await db.exec(await readFile(new URL('../supabase/admin.sql',import.meta.url),'utf8'));
 await db.query('insert into public.sixfps_admins values ($1),($2)',[admin,author]);
 const migration=await readFile(new URL('../supabase/projects.sql',import.meta.url),'utf8');
 await db.exec(migration);
 const call=async(name,args=[]) => (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as s`,args)).rows[0].s;
 const movie=(id=1)=>call('sixfps_project_state',[id]);
 const book=(id=1)=>call('sixfps_project_book',[id]);
 const edit=async(action,frame=null,pos=null,id=1)=>call('sixfps_project_edit',[id,action,frame,pos,(await movie(id)).revision]);
 const submit=async(id,b,user)=>{
  await db.query("insert into storage.objects(bucket_id,name,owner_id) values ('sixfps-frames',$1,$2)",[b.path,user]);
  return call('sixfps_project_publish',[id,b.token]);
 };
 assert.equal((await movie()).count,0);
 assert.equal((await db.query('select archived from public.sixfps_frames where id=1')).rows[0].archived,true);
 await as('', 'anon'); assert.equal((await movie()).frames.length,0);
 await assert.rejects(()=>book(),/permission denied/);
 await as(author); await assert.rejects(()=>call('sixfps_project_create',['No']),/Admin access required/);
 await assert.rejects(()=>call('sixfps_book'),/permission denied/);
 await assert.rejects(()=>call('sixfps_publish',['00000000-0000-4000-8000-000000000001']),/permission denied/);
 await assert.rejects(()=>edit('clear'),/Admin access required/);
 await as(admin); const other=await call('sixfps_project_create',['Second movie']); assert.equal(other,2);
 await as(author); const a=(await book()).booking; assert.equal(a.slot,1);
 assert.equal((await book()).booking.token,a.token);
 const preview='data:image/png;base64,aGVsbG8=';
 await call('sixfps_project_draft',[1,a.token,preview]);
 await as(outsider); const b=(await book()).booking; assert.equal(b.slot,2);
 assert.equal((await movie()).booking.token,b.token); // no other user's token in public state
 await assert.rejects(()=>call('sixfps_project_draft',[1,a.token,preview]),/booking has ended/);
 await assert.rejects(()=>call('sixfps_project_publish',[1,a.token]),/booking has ended/);
 await assert.rejects(()=>call('sixfps_project_publish',[other,b.token]),/booking has ended/);
 await assert.rejects(()=>db.query('update public.sixfps_drafts set image=$1',[preview]),/permission denied/);
 await assert.rejects(()=>call('sixfps_project_draft',[1,b.token,'not an image']),/Invalid preview/);
 await as('','anon'); assert.equal((await db.query('select image from public.sixfps_drafts')).rows[0].image,preview);
 assert.equal((await movie()).booking,null);
 assert.ok((await movie()).reservations.every(r=>!('token' in r)&&!('owner' in r)));
 await as(admin); await assert.rejects(()=>edit('restore',1),/being drawn/);
 await as(outsider); let result=await submit(1,b,outsider);assert.deepEqual(result.frames.map(f=>f.slot),[2]);
 assert.equal((await call('sixfps_project_publish',[1,b.token])).count,1);
 await as(author); result=await submit(1,a,author); assert.deepEqual(result.frames.map(f=>f.slot),[1,2]);
 assert.equal((await db.query('select * from public.sixfps_drafts')).rows.length,0);
 const expired=(await book()).booking; assert.equal(expired.slot,3);
 await call('sixfps_project_draft',[1,expired.token,preview]);
 await db.exec('reset role');await db.exec("update public.sixfps_booking set expires_at=now()-interval '1 second'; update public.sixfps_drafts set expires_at=now()-interval '1 second'");
 await as('','anon');assert.equal((await db.query('select * from public.sixfps_drafts')).rows.length,0);
 await as(outsider);const replacement=(await book()).booking;assert.equal(replacement.slot,3);assert.notEqual(replacement.token,expired.token);
 assert.equal((await db.query('select * from public.sixfps_drafts')).rows.length,0);
 await call('sixfps_project_release',[1,replacement.token]);
 // Publish exactly 90 frames, including an initially out-of-order pair.
 await as(author);
 for(let n=3;n<=90;n++){const turn=(await book()).booking;assert.equal(turn.slot,n);await submit(1,turn,author);}
 result=await movie();assert.equal(result.count,90);assert.equal(result.complete,true);assert.equal(result.frames.length,90);
 await assert.rejects(()=>book(),/complete/);
 const otherTurn=(await book(other)).booking;assert.equal(otherTurn.slot,1);await submit(other,otherTurn,author);
 await as(admin);await assert.rejects(()=>edit('restore',1),/90 frames/);
 const first=result.frames[0].id,second=result.frames[1].id;
 await edit('move',first,2);result=await movie();assert.equal(result.frames.find(f=>f.id===first).slot,2);assert.equal(result.frames.find(f=>f.id===second).slot,1);
 await assert.rejects(()=>edit('archive',first,null,other),/Frame not found/);
 await edit('archive',first);assert.equal((await movie()).count,89);
 await as(author);const opened=(await book()).booking;assert.equal(opened.slot,2);await call('sixfps_project_release',[1,opened.token]);
 await as(admin);await edit('restore',first);assert.equal((await movie()).count,90);
 // Rerunning never clears new contributions or resets their immutable IDs.
 await db.exec('reset role');await db.exec(migration);assert.equal((await movie()).count,90);
 await as(admin);await edit('clear');assert.equal((await movie()).count,0);assert.equal((await movie(other)).count,1);
 assert.equal((await call('sixfps_project_admin_state',[1])).frames.filter(f=>f.archived).length,91);
 await as(author);const postClear=(await book()).booking;assert.equal(postClear.slot,1);result=await submit(1,postClear,author);
 assert.ok(result.frames[0].id>90);
 const lastId=result.frames[0].id;
 await as(admin);await edit('archive',lastId);await edit('prepare_delete',lastId);
 await db.query('delete from storage.objects where name=$1',[postClear.path]);await edit('finish_delete',lastId);
 await db.exec('reset role');await db.exec(migration);
 await as(author);result=await submit(1,(await book()).booking,author);assert.ok(result.frames[0].id>lastId);
 } finally {await db.close();}
});
