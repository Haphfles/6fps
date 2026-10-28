import config from './config.js';

let clientPromise;
async function client() {
  if (!clientPromise) clientPromise = import('./vendor/supabase.js').then(({ createClient }) => createClient(config.url, config.publishableKey));
  return clientPromise;
}
function check(error) {
  if (!error) return;
  if (error.code === 'PGRST202' || error.code === '42P01') throw new Error('Database setup needed. Run supabase/setup.sql in Supabase.');
  if (/anonymous.*disabled/i.test(error.message)) throw new Error('Enable anonymous sign-ins in Supabase Authentication settings.');
  throw new Error(error.message || 'Could not connect. Please try again.');
}
let signInPromise;
async function identity() {
  if (!signInPromise) signInPromise = (async () => {
    const sb = await client();
    const { data, error } = await sb.auth.getSession(); check(error);
    if (!data.session) { const result = await sb.auth.signInAnonymously(); check(result.error); }
  })().finally(() => { signInPromise = null; });
  return signInPromise;
}
const paths = new Map();
let booking = null, pendingPublish = null;
async function rpc(name, args = {}) {
  const sb = await client(); const { data, error } = await sb.rpc(name, args); check(error); return data;
}
function remember(state) { booking = state.booking?.mine ? state.booking : null; return state; }
async function frame(n) {
  const sb = await client();
  if (!paths.has(n)) {
    const { data, error } = await sb.from('sixfps_frames').select('id,object_path').eq('id', n).single();
    check(error); paths.set(n, data.object_path);
  }
  return { image: sb.storage.from('sixfps-frames').getPublicUrl(paths.get(n)).data.publicUrl };
}
async function publish(image) {
  const sb = await client();
  // Retry completion first if an earlier upload succeeded but the final response was lost.
  if (pendingPublish?.uploaded) {
    const state = await rpc('sixfps_publish', { booking_token: pendingPublish.token });
    pendingPublish = null; return remember(state);
  }
  if (!booking) throw new Error('Book a frame before publishing.');
  if (!/^data:image\/png;base64,/.test(image)) throw new Error('Please publish a PNG drawing.');
  const bytes = Uint8Array.from(atob(image.split(',')[1]), char => char.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'image/png' });
  if (blob.size > 2097152) throw new Error('This drawing exceeds the 2 MB frame limit.');
  pendingPublish = { token: booking.token, path: booking.path, uploaded: false };
  const { error } = await sb.storage.from('sixfps-frames').upload(pendingPublish.path, blob, { contentType: 'image/png', upsert: false, cacheControl: '31536000' });
  // Existing objects may be a successful upload whose network response was lost.
  if (error && !/already exists|duplicate/i.test(error.message)) check(error);
  pendingPublish.uploaded = true;
  const state = await rpc('sixfps_publish', { booking_token: pendingPublish.token });
  pendingPublish = null; return remember(state);
}
export async function api(route, body) {
  if (config.backend === 'local') {
    const res = await fetch(`/api/${route}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json(); if (!res.ok) throw new Error(data.error); return data;
  }
  if (route === 'state') return remember(await rpc('sixfps_state'));
  if (route.startsWith('frames/')) return frame(Number(route.split('/')[1]));
  await identity();
  if (route === 'book') {
    const state = await rpc('sixfps_book');
    if (pendingPublish && pendingPublish.token !== state.booking?.token) pendingPublish = null;
    return remember(state);
  }
  if (route === 'release') {
    if (!booking) throw new Error('Your booking has ended.');
    const state = await rpc('sixfps_release', { booking_token: booking.token });
    pendingPublish = null; return remember(state);
  }
  if (route === 'frames') return publish(body.image);
  throw new Error('Unknown request.');
}
export const pollInterval = config.backend === 'local' ? 3000 : 10000;
