import { api, pollInterval } from './backend.js';
const $ = id => document.getElementById(id);
const canvas = $('drawing'), ctx = canvas.getContext('2d'), onion = $('onion').getContext('2d');
let state = { count: 0, booking: null }, selected = 0, tool = 'pen', drawing = false, editing = false, busy = false, playback = null, history = [], future = [], images = new Map(), renderToken = 0, draft = null;
const blank = () => ctx.clearRect(0, 0, 540, 960);
function toast(message) { $('toast').textContent = message; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').textContent = '', 5000); }
async function imageAt(n) { if (!images.has(n)) images.set(n, api(`frames/${n}`).then(data => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('Could not load frame. Please try again.')); image.crossOrigin = 'anonymous'; image.src = data.image; })).catch(e => { images.delete(n); throw e; })); return images.get(n); }
function stop() { clearInterval(playback); playback = null; $('play').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v14l11-7z"/></svg>'; $('play').classList.remove('playing'); $('play').setAttribute('aria-label', 'Play movie'); }
function update() {
  const mine = state.booking?.mine;
  $('book').hidden = !!mine; $('publish').hidden = !mine; $('release').hidden = !mine;
  $('book').disabled = busy || !!state.booking; $('publish').disabled = busy || !editing || !history.length; $('release').disabled = busy;
  $('booking-status').textContent = state.booking && !mine ? 'Frame booked' : '';
  $('canvas-title').textContent = String(editing ? state.count + 1 : selected).padStart(3, '0') + (editing ? ' / DRAW' : '');
  $('scrubber').max = Math.max(1, state.count); $('scrubber').value = selected || 1; $('scrubber').disabled = !state.count;
  $('position').textContent = `${String(editing ? state.count + 1 : selected).padStart(3, '0')} / ${String(state.count).padStart(3, '0')}`;
  $('play').disabled = !state.count || busy;
  $('undo').disabled = !editing || !history.length; $('redo').disabled = !editing || !future.length;
  canvas.style.cursor = editing ? 'crosshair' : 'default';
  document.querySelectorAll('.frame[data-index]').forEach(el => el.classList.toggle('selected', Number(el.dataset.index) === (editing ? state.count + 1 : selected)));
}
// Fit older landscape frames without changing or deleting the original artwork.
function fit(context, image) {
  const scale = Math.min(540 / image.width, 960 / image.height);
  context.save(); context.filter = 'grayscale(1)';
  context.drawImage(image, (540 - image.width * scale) / 2, (960 - image.height * scale) / 2, image.width * scale, image.height * scale);
  context.restore();
}
async function show(n) {
  const token = ++renderToken;
  if (editing) draft = canvas.toDataURL();
  editing = false; selected = n; onion.clearRect(0, 0, 540, 960); blank(); update();
  if (n) { const image = await imageAt(n); if (token === renderToken) fit(ctx, image); }
}
async function resume() {
  if (!state.booking?.mine) return;
  stop(); const token = ++renderToken; editing = true; selected = 0; blank(); onion.clearRect(0, 0, 540, 960);
  if (draft) { const img = await loadImage(draft); if (token === renderToken) ctx.drawImage(img, 0, 0); }
  if (state.count) { const img = await imageAt(state.count); if (token === renderToken) fit(onion, img); }
  update();
}
function loadImage(src) { return new Promise(resolve => { const img = new Image(); img.onload = () => resolve(img); img.src = src; }); }
async function strip() {
  const el = $('filmstrip'); el.replaceChildren();
  for (let n = 1; n <= state.count; n++) {
    const button = document.createElement('button'); button.className = 'frame'; button.dataset.index = n; button.setAttribute('aria-label', `View frame ${n}`); button.onclick = () => { stop(); show(n).catch(e => toast(e.message)); };
    const label = document.createElement('span'); label.textContent = String(n).padStart(3, '0'); button.append(label); el.append(button);
    imageAt(n).then(img => { const thumb = img.cloneNode(); thumb.alt = ''; button.prepend(thumb); }).catch(() => {});
  }
  const next = document.createElement('button'); next.className = 'frame next'; next.textContent = '+'; next.dataset.index = state.count + 1; next.setAttribute('aria-label', state.booking?.mine ? 'Return to your drawing' : 'Book the next frame'); next.onclick = () => state.booking?.mine ? resume().catch(e => toast(e.message)) : book(); el.append(next);
  for (let n = state.count; n < 28; n++) { const placeholder = document.createElement('div'); placeholder.className = 'frame placeholder'; el.append(placeholder); }
  update();
}
async function refresh() {
  const previous = state; state = await api('state');
  if (previous.booking?.mine && !state.booking?.mine) { if (editing) draft = canvas.toDataURL(); editing = false; toast('Your turn ended. Your drawing is kept in this tab.'); await show(state.count); }
  const changed = state.count !== previous.count || state.revision !== previous.revision;
  if (changed) {
    stop(); images.clear();
    if (editing) { onion.clearRect(0, 0, 540, 960); if (state.count) fit(onion, await imageAt(state.count)); }
    else await show(Math.min(selected || state.count, state.count));
  }
  if (changed || !!state.booking?.mine !== !!previous.booking?.mine) await strip();
  update();
}
async function book() {
  if (busy || state.booking && !state.booking.mine) return;
  busy = true; stop(); update();
  try { state = await api('book', {}); await resume(); await strip(); toast('Frame booked'); } catch (e) { toast(e.message); await refresh().catch(() => {}); } finally { busy = false; update(); }
}
$('book').onclick = book;
$('release').onclick = async () => { if (!confirm('Leave your turn? Your drawing will stay in this tab, but someone else can book the next frame.')) return; busy = true; update(); try { if (editing) draft = canvas.toDataURL(); state = await api('release', {}); editing = false; await show(state.count); await strip(); } catch(e) { toast(e.message); } finally { busy = false; update(); } };
$('publish').onclick = async () => {
  if (busy || !editing) return; busy = true; update();
  const output = document.createElement('canvas'); output.width = 540; output.height = 960; const c = output.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, 540, 960); c.drawImage(canvas, 0, 0);
  try { state = await api('frames', { image: output.toDataURL('image/png') }); editing = false; draft = null; history = []; future = []; await show(state.count); await strip(); toast('Frame published'); } catch (e) { toast(e.message); } finally { busy = false; update(); }
};
function point(e) { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * 540 / r.width, (e.clientY - r.top) * 960 / r.height]; }
function saveUndo() { history.push(canvas.toDataURL()); if (history.length > 30) history.shift(); future = []; }
let shape = 'round', lastPoint = null, stamp = null, stampSize = 0;
function makeStamp() {
  const size = Number($('size').value), wet = Number($('wetness').value) / 100;
  const brush = document.createElement('canvas'); brush.width = brush.height = Math.ceil(size * 2 + 8);
  const c = brush.getContext('2d'), mid = brush.width / 2;
  c.fillStyle = '#000';
  if (tool === 'pen') { c.globalAlpha = .65 + wet * .35; c.shadowColor = '#000'; c.shadowBlur = wet * size * .07; }
  if (shape === 'square' && tool === 'pen') c.fillRect(mid - size / 2, mid - size / 2, size, size);
  else { c.beginPath(); c.arc(mid, mid, size / 2, 0, Math.PI * 2); c.fill(); }
  // Dry ink has a broken paper texture; wet ink makes a denser, softer mark.
  if (tool === 'pen' && wet < .95) {
    c.shadowBlur = 0; c.globalAlpha = 1; c.globalCompositeOperation = 'destination-out';
    let seed = 12345;
    const rand = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < size * size * (1 - wet) * .3; i++) c.clearRect(mid - size / 2 + rand() * size, mid - size / 2 + rand() * size, 1, 1);
  }
  stamp = brush; stampSize = size;
}
function dab(x, y) { ctx.drawImage(stamp, x - stamp.width / 2, y - stamp.height / 2); }
canvas.onpointerdown = e => {
  if (!editing || busy || !state.booking?.mine || e.button !== 0 || drawing) return;
  e.preventDefault(); closeSettings(); saveUndo(); drawing = true; canvas.setPointerCapture(e.pointerId);
  ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
  makeStamp(); lastPoint = point(e); dab(...lastPoint); update();
};
canvas.onpointermove = e => {
  if (!drawing) return;
  const events = e.getCoalescedEvents?.();
  for (const p of events?.length ? events : [e]) {
    const next = point(p), dx = next[0] - lastPoint[0], dy = next[1] - lastPoint[1];
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(.5, stampSize * .13)));
    for (let i = 1; i <= steps; i++) dab(lastPoint[0] + dx * i / steps, lastPoint[1] + dy * i / steps);
    lastPoint = next;
  }
};
function endStroke() { if (!drawing) return; drawing = false; ctx.globalCompositeOperation = 'source-over'; draft = canvas.toDataURL(); update(); }
canvas.onpointerup = endStroke; canvas.onpointercancel = endStroke; canvas.onlostpointercapture = endStroke;
function closeSettings() { $('pen-settings').hidden = true; document.querySelector('[data-tool="pen"]').setAttribute('aria-expanded', 'false'); }
document.querySelectorAll('[data-tool]').forEach(button => button.onclick = () => {
  const open = button.dataset.tool === 'pen' && (tool !== 'pen' || $('pen-settings').hidden);
  tool = button.dataset.tool; closeSettings();
  if (open) { $('pen-settings').hidden = false; button.setAttribute('aria-expanded', 'true'); }
  document.querySelectorAll('[data-tool]').forEach(b => { b.classList.toggle('active', b === button); b.setAttribute('aria-pressed', String(b === button)); });
});
document.querySelectorAll('[data-shape]').forEach(button => button.onclick = () => {
  shape = button.dataset.shape;
  document.querySelectorAll('[data-shape]').forEach(b => { b.classList.toggle('chosen', b === button); b.setAttribute('aria-pressed', String(b === button)); });
});
for (const name of ['size', 'wetness']) $(name).oninput = () => $(name + '-value').textContent = $(name).value;
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSettings(); });
document.addEventListener('pointerdown', e => { if (!e.target.closest('#pen-settings, [data-tool="pen"]')) closeSettings(); });
async function restore(from, to) { if (!editing || busy || !from.length) return; busy = true; to.push(canvas.toDataURL()); const img = await loadImage(from.pop()); blank(); ctx.globalCompositeOperation = 'source-over'; ctx.drawImage(img, 0, 0); draft = canvas.toDataURL(); busy = false; update(); }
$('undo').onclick = () => restore(history, future); $('redo').onclick = () => restore(future, history);
function opacity() { $('onion').style.opacity = Number($('opacity').value) / 100; $('opacity-value').textContent = `${$('opacity').value}%`; }
$('opacity').oninput = opacity;
$('scrubber').oninput = () => { stop(); show(Number($('scrubber').value)).catch(e => toast(e.message)); };
$('play').onclick = async () => {
  if (playback) return stop();
  try { busy = true; update(); await Promise.all(Array.from({ length: state.count }, (_, i) => imageAt(i + 1))); await show(1); busy = false; update(); $('play').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM15 5h4v14h-4z"/></svg>'; $('play').classList.add('playing'); $('play').setAttribute('aria-label', 'Pause movie'); playback = setInterval(() => show(selected % state.count + 1), 1000 / 6); } catch(e) { busy = false; update(); toast(e.message); }
};
let scrubDrag = null, suppressClick = false;
const filmstrip = $('filmstrip');
filmstrip.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !state.count) return;
  scrubDrag = { x: e.clientX, left: filmstrip.scrollLeft, frame: selected || 1, moved: false, id: e.pointerId };
});
filmstrip.addEventListener('pointermove', e => {
  if (!scrubDrag) return;
  const delta = e.clientX - scrubDrag.x;
  if (!scrubDrag.moved && Math.abs(delta) < 5) return;
  scrubDrag.moved = true; filmstrip.setPointerCapture(e.pointerId); stop();
  filmstrip.scrollLeft = scrubDrag.left + delta;
  const rect = filmstrip.getBoundingClientRect(), first = filmstrip.querySelector('.frame');
  const step = first.getBoundingClientRect().width + 6;
  const n = Math.max(1, Math.min(state.count, scrubDrag.frame + Math.round(delta / step)));
  if (n !== selected || editing) show(n).catch(e => toast(e.message));
});
function endScrub() { suppressClick = !!scrubDrag?.moved; scrubDrag = null; setTimeout(() => { suppressClick = false; }, 0); }
filmstrip.addEventListener('pointerup', endScrub); filmstrip.addEventListener('pointercancel', endScrub);
filmstrip.addEventListener('click', e => { if (suppressClick) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
window.addEventListener('beforeunload', e => { if (draft && state.booking?.mine) { e.preventDefault(); e.returnValue = ''; } });
(async () => { try { state = await api('state'); await strip(); if (state.booking?.mine) await resume(); else await show(state.count); } catch(e) { toast(e.message); } })();
setInterval(() => { if (!busy && !drawing && document.visibilityState === 'visible') refresh().catch(() => {}); }, pollInterval);
setInterval(() => { if (!busy && state.booking?.mine && document.visibilityState === 'visible') api('book', {}).then(s => { state = s; update(); }).catch(() => refresh().catch(() => {})); }, 60000);
