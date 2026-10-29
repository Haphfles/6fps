import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'movie.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS frames (id INTEGER PRIMARY KEY, image TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS booking (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);`);
const duration = 10 * 60 * 1000;
function state(owner) {
  const booking = db.prepare('SELECT * FROM booking WHERE expires_at > ?').get(Date.now());
  return { count: db.prepare('SELECT COUNT(*) AS count FROM frames').get().count, booking: booking ? { mine: booking.owner === owner, expiresAt: booking.expires_at } : null };
}
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 3_000_000) throw Object.assign(new Error('Frame is too large.'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw Object.assign(new Error('Invalid request.'), { status: 400 }); }
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob: https://wvsqgtmsskmxddkynhzt.supabase.co; style-src 'self'; script-src 'self'; connect-src 'self' https://wvsqgtmsskmxddkynhzt.supabase.co wss://wvsqgtmsskmxddkynhzt.supabase.co; frame-ancestors 'none'");
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')));
  let owner = cookies.session;
  if (!/^[a-f0-9-]{36}$/.test(owner || '')) { owner = randomUUID(); res.setHeader('Set-Cookie', `session=${owner}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${process.env.SECURE_COOKIES === 'true' ? '; Secure' : ''}`); }
  const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `${process.env.SECURE_COOKIES === 'true' ? 'https' : 'http'}://${req.headers.host}`) return send(403, { error: 'Request origin is not allowed.' });
    if (req.method === 'GET' && url.pathname === '/api/state') return send(200, state(owner));
    if (req.method === 'GET' && /^\/api\/frames\/\d+$/.test(url.pathname)) {
      const frame = db.prepare('SELECT image FROM frames WHERE id = ?').get(Number(url.pathname.split('/').at(-1)));
      return send(frame ? 200 : 404, frame || { error: 'Frame not found.' });
    }
    if (req.method === 'POST' && ['/api/book', '/api/release', '/api/frames'].includes(url.pathname)) {
      const input = url.pathname === '/api/frames' ? await body(req) : null;
      const result = transaction(() => {
        const current = state(owner);
        if (url.pathname === '/api/book') {
          if (current.booking && !current.booking.mine) return { status: 409, value: { error: 'Someone is drawing this frame. Try again when their turn ends.' } };
          db.prepare('INSERT OR REPLACE INTO booking VALUES (1, ?, ?)').run(owner, Date.now() + duration);
        } else {
          if (!current.booking?.mine) return { status: 409, value: { error: 'Your booking has ended. Book the next frame to continue.' } };
          if (url.pathname === '/api/frames') {
            if (typeof input?.image !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(input.image)) return { status: 400, value: { error: 'Please submit a PNG frame.' } };
            const bytes = Buffer.from(input.image.split(',')[1], 'base64');
            if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== 1080 || bytes.readUInt32BE(20) !== 1920) return { status: 400, value: { error: 'Frame must be a 1080 × 1920 PNG.' } };
            db.prepare('INSERT INTO frames VALUES (?, ?, ?)').run(current.count + 1, input.image, Date.now());
          }
          db.prepare('DELETE FROM booking WHERE id = 1').run();
        }
        return { status: 200, value: state(owner) };
      });
      return send(result.status, result.value);
    }
    if (req.method === 'GET' && url.pathname === '/config.js' && process.env.SIXFPS_BACKEND === 'legacy') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      return res.end("export default { backend: 'local' };");
    }
    const files = { '/': ['index.html', 'text/html'], '/admin.html': ['admin.html', 'text/html'], '/admin.css': ['admin.css', 'text/css'], '/admin.js': ['admin.js', 'text/javascript'], '/admin-api.js': ['admin-api.js', 'text/javascript'], '/app.js': ['app.js', 'text/javascript'], '/backend.js': ['backend.js', 'text/javascript'], '/video-export.js': ['video-export.js', 'text/javascript'], '/vendor/mediabunny.js': ['vendor/mediabunny.js', 'text/javascript'], '/config.js': ['config.js', 'text/javascript'], '/vendor/supabase.js': ['vendor/supabase.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    if (req.method === 'GET' && files[url.pathname]) { const [file, type] = files[url.pathname]; res.writeHead(200, { 'Content-Type': type }); return res.end(readFileSync(path.join(root, 'public', file))); }
    send(404, { error: 'Not found.' });
  } catch (e) { if (!e.status) console.error(e); send(e.status || 500, { error: e.status ? e.message : 'Something went wrong. Please try again.' }); }
});
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.log(`6FPS is running at http://${process.env.HOST || 'localhost'}:${server.address().port}`));
