import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Runs the real migration and policies in embedded Postgres, with Supabase's
// auth/storage tables represented by a minimal local fixture. No live data used.
test('Supabase roles, reservation ownership, expiry, immutable frames, and safe retry', async () => {
  const db = new PGlite();
  const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth; create schema storage;
      create table auth.users(id uuid primary key);
      insert into auth.users values ('${a}'), ('${b}');
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth, storage to anon, authenticated;
      grant execute on function auth.uid() to anon, authenticated;
      create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects(id bigint generated always as identity primary key, bucket_id text, name text, owner_id text, unique(bucket_id, name));
      alter table storage.objects enable row level security;
      grant select, insert, update, delete on storage.objects to authenticated;
      grant usage on sequence storage.objects_id_seq to authenticated;
    `);
    const sql = await readFile(new URL('../supabase/setup.sql', import.meta.url), 'utf8');
    await db.exec(sql); await db.exec(sql); // Reruns preserve state and recreate only named policies.
    async function as(role, id = '') { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]); await db.exec(`set role ${role}`); }
    async function rpc(name, token) { return (await db.query(`select public.${name}(${token ? '$1::uuid' : ''}) as result`, token ? [token] : [])).rows[0].result; }
    await as('anon');
    assert.equal((await rpc('sixfps_state')).count, 0);
    await assert.rejects(() => rpc('sixfps_book'), /permission denied/);
    await as('authenticated', a);
    const booked = await rpc('sixfps_book'), token = booked.booking.token, objectPath = booked.booking.path;
    assert.equal(booked.booking.mine, true);
    assert.equal((await rpc('sixfps_book')).booking.token, token);
    await assert.rejects(() => rpc('sixfps_publish', token), /Upload your drawing/);
    await assert.rejects(() => db.query('insert into public.sixfps_movie values (2, 0)'), /permission denied/);
    await as('authenticated', b);
    const viewed = await rpc('sixfps_state');
    assert.equal(viewed.booking.mine, false); assert.equal(viewed.booking.token, null); assert.equal(viewed.booking.path, null);
    await assert.rejects(() => rpc('sixfps_book'), /already booked/);
    await assert.rejects(() => rpc('sixfps_release', token), /no longer yours/);
    await assert.rejects(() => rpc('sixfps_publish', token), /booking has ended/);
    await assert.rejects(() => db.query("insert into storage.objects(bucket_id,name,owner_id) values ('sixfps-frames',$1,$2)", [objectPath,b]), /row-level security/);
    await as('authenticated', a);
    await assert.rejects(() => db.query("insert into storage.objects(bucket_id,name,owner_id) values ('sixfps-frames','unreserved.png',$1)",[a]), /row-level security/);
    await db.query("insert into storage.objects(bucket_id,name,owner_id) values ('sixfps-frames',$1,$2)",[objectPath,a]);
    assert.equal((await rpc('sixfps_publish', token)).count, 1);
    assert.equal((await rpc('sixfps_publish', token)).count, 1); // response-loss retry
    await assert.rejects(() => db.exec('delete from public.sixfps_frames'), /permission denied/);
    assert.equal((await db.query('delete from storage.objects returning id')).rows.length, 0);
    await as('anon');
    assert.equal((await db.query('select id, object_path from public.sixfps_frames')).rows.length, 1);
    await assert.rejects(() => db.exec('select booking_token from public.sixfps_frames'), /permission denied/);
    await as('authenticated', a); const expired = await rpc('sixfps_book');
    await db.exec("reset role; update public.sixfps_booking set expires_at = now() - interval '1 second'");
    await as('authenticated', b); const next = await rpc('sixfps_book'); assert.notEqual(next.booking.token, expired.booking.token);
    await as('authenticated', a); await assert.rejects(() => rpc('sixfps_publish', expired.booking.token), /booking has ended/);
    await as('authenticated', b); assert.equal((await rpc('sixfps_release', next.booking.token)).booking, null);
    await db.exec('reset role');
    await db.exec(sql); // migration rerun does not erase the film
    await as('anon'); assert.equal((await rpc('sixfps_state')).count, 1);
  } finally { await db.close(); }
});
