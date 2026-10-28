import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

test('exclusive reservations, ownership, publication, and durable storage', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sharedmovie-test-'));
  let child;
  async function start() {
    child = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: '0', DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    const [chunk] = await once(child.stdout, 'data');
    return String(chunk).match(/http:\/\/localhost:\d+/)[0];
  }
  async function stop() { child.kill(); await once(child, 'exit'); }
  try {
    let base = await start();
    const a = (await fetch(base + '/api/state')).headers.get('set-cookie').split(';')[0];
    const b = (await fetch(base + '/api/state')).headers.get('set-cookie').split(';')[0];
    const post = (route, cookie, body = {}) => fetch(base + route, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const [first, second] = await Promise.all([post('/api/book', a), post('/api/book', b)]);
    assert.deepEqual([first.status, second.status].sort(), [200,409]);
    const owner = first.status === 200 ? a : b, other = owner === a ? b : a;
    assert.equal((await post('/api/release', other)).status, 409);
    assert.equal((await post('/api/frames', other, { image: 'anything' })).status, 409);
    assert.equal((await post('/api/frames', owner, { image: 'invalid' })).status, 400);
    assert.equal((await post('/api/book', owner)).status, 200);
    // Minimal PNG header verifies server's format/dimension boundary, not image decoding.
    const png = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a','hex').copy(png); png.writeUInt32BE(540,16); png.writeUInt32BE(960,20);
    const publish = await post('/api/frames', owner, { image: 'data:image/png;base64,' + png.toString('base64') });
    assert.equal(publish.status, 200); assert.equal((await publish.json()).count, 1);
    assert.equal((await post('/api/frames', owner, { image: 'invalid' })).status, 409);
    assert.equal((await post('/api/book', other)).status, 200);
    assert.equal((await post('/api/release', other)).status, 200);
    await stop(); base = await start();
    assert.equal((await (await fetch(base + '/api/state')).json()).count, 1);
    assert.equal((await fetch(base + '/api/frames/1')).status, 200);
    assert.equal((await fetch(base + '/api/frames/2')).status, 404);
  } finally { if (child && child.exitCode === null) await stop(); rmSync(dir, { recursive:true, force:true }); }
});
