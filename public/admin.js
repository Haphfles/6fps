import { session, login, logout, loadMovie, imageUrl, edit, deleteFrame, listProjects, selectProject, createProject } from './admin-api.js';
const $ = id => document.getElementById(id);
const playSVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v14l11-7z"/></svg>';
const pauseSVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM15 5h4v14h-4z"/></svg>';
let data = null, selected = null, archived = false, busy = false, timer = null;
const frames = () => (data?.frames.filter(f => f.archived === archived) || []).sort((a,b) => archived ? a.id - b.id : a.position - b.position);
const active = () => data?.frames.filter(f => !f.archived).sort((a,b) => a.position - b.position) || [];
function message(text) { $('message').textContent = text; }
function stop() { clearInterval(timer); timer = null; $('admin-play').innerHTML = playSVG; $('admin-play').setAttribute('aria-label', 'Play movie'); }
function selectedFrame() { return data?.frames.find(f => f.id === selected); }
function renderSelection() {
  const f = selectedFrame();
  $('preview-image').hidden = !f; $('empty-preview').hidden = !!f;
  if (f) { $('preview-image').src = imageUrl(f.path); $('preview-image').alt = `Frame ${f.position || f.id}`; }
  $('preview-number').textContent = f ? (f.archived ? `ARCHIVE / ${f.id}` : String(f.position).padStart(3,'0')) : '000';
  $('selection-tools').hidden = !f;
  $('selection-label').textContent = f ? `FRAME ${f.id} · ${new Date(f.createdAt).toLocaleDateString()}${f.purging ? ' · DELETION PENDING' : ''}` : '';
  $('move-form').hidden = !f || f.archived; $('archive').hidden = !f || f.archived;
  $('restore').hidden = !f?.archived; $('delete').hidden = !f?.archived;
  $('restore').disabled = busy || !!f?.purging;
  $('move-position').max = 90; $('move-position').value = f?.position || 1;
  $('admin-scrub').max = Math.max(1, active().length); $('admin-scrub').value = Math.max(1, active().findIndex(x => x.id === f?.id) + 1);
  $('admin-scrub').disabled = busy || !data?.movie.count;
  $('admin-play').disabled = busy || !data?.movie.count;
  $('frame-grid').querySelectorAll('button').forEach(b => b.classList.toggle('selected', Number(b.dataset.id) === selected));
}
function render() {
  $('stats').textContent = `${data.movie.count}/90 frames · ${(data.movie.count / 6).toFixed(1)}/15s${data.movie.complete ? ' · COMPLETE' : ''}`;
  $('booking-state').textContent = data.movie.reservations.length ? `${data.movie.reservations.length} active bookings` : 'No active bookings';
  $('release-booking').hidden = !data.movie.reservations.length;
  $('active-count').textContent = active().length; $('archive-count').textContent = data.frames.filter(f => f.archived).length;
  $('movie-tab').setAttribute('aria-selected', String(!archived)); $('archive-tab').setAttribute('aria-selected', String(archived));
  const list = frames(); if (!list.some(f => f.id === selected)) selected = list[0]?.id ?? null;
  const grid = $('frame-grid'); grid.replaceChildren();
  if (!list.length) { const empty = document.createElement('p'); empty.className = 'empty-grid'; empty.textContent = archived ? 'Archive is empty.' : 'No published frames.'; grid.append(empty); }
  for (const f of list) {
    const button = document.createElement('button'); button.className = 'frame-card'; button.dataset.id = f.id;
    button.setAttribute('aria-label', `Select ${f.archived ? 'archived ' : ''}frame ${f.position || f.id}`);
    const img = document.createElement('img'); img.src = imageUrl(f.path); img.alt = ''; img.loading = 'lazy';
    const label = document.createElement('span'); label.textContent = f.purging ? 'DELETE PENDING' : String(f.position || f.id).padStart(3,'0');
    button.append(img,label); button.onclick = () => { stop(); selected = f.id; renderSelection(); }; grid.append(button);
  }
  renderSelection();
}
function setBusy(value) { busy = value; document.querySelectorAll('button').forEach(b => b.disabled = value); $('admin-project').disabled=value; $('project-name').disabled=value; if (data) renderSelection(); }
async function refresh() { data = await loadMovie(); render(); }
async function openEditor() {
  await fillProjects(); await refresh(); $('login-panel').hidden = true; $('editor').hidden = false; $('logout').hidden = false; $('refresh').hidden = false; message('');
}
$('login-form').onsubmit = async e => {
  e.preventDefault(); setBusy(true); message('Signing in…');
  try { await login($('email').value.trim(), $('password').value); $('password').value = ''; await openEditor(); }
  catch(e) { message(e.message); } finally { setBusy(false); }
};
$('logout').onclick = async () => {
  stop(); setBusy(true);
  try { await logout(); data = null; selected = null; $('frame-grid').replaceChildren(); $('preview-image').removeAttribute('src'); $('editor').hidden = true; $('login-panel').hidden = false; $('logout').hidden = true; $('refresh').hidden = true; message(''); }
  catch(e) { message(e.message); } finally { setBusy(false); }
};
$('refresh').onclick = async () => { stop(); setBusy(true); try { await refresh(); message('Updated.'); } catch(e) { message(e.message); } finally { setBusy(false); } };
function tab(archive) { stop(); archived = archive; render(); }
$('movie-tab').onclick = () => tab(false); $('archive-tab').onclick = () => tab(true);
async function mutate(action, position = null) {
  if (busy || !data) return; stop(); setBusy(true); message('Saving…');
  try { data = await edit(action, selected, position, data.movie.revision); render(); message('Saved.'); }
  catch(e) { const original = e.message; await refresh().catch(() => {}); message(original); }
  finally { setBusy(false); }
}
$('move-form').onsubmit = e => { e.preventDefault(); mutate('move', Number($('move-position').value)); };
$('archive').onclick = () => mutate('archive');
$('restore').onclick = () => mutate('restore');
$('release-booking').onclick = () => { if (confirm('Release all active bookings in this movie? Contributors will need to reserve again.')) mutate('release'); };
$('delete').onclick = async () => {
  const f = selectedFrame(); if (!f || busy || !confirm(`Permanently delete archived frame ${f.id} and its image? This cannot be undone.`)) return;
  stop(); setBusy(true); message('Deleting…');
  try { data = await deleteFrame(f, data.movie.revision); render(); message('Frame deleted.'); }
  catch(e) { const original = e.message; await refresh().catch(() => {}); message(`${original}\nIf deletion is pending, use Delete permanently again to finish.`); }
  finally { setBusy(false); }
};
$('admin-scrub').oninput = () => { stop(); archived = false; selected = active()[Number($('admin-scrub').value) - 1]?.id ?? null; render(); };
$('admin-play').onclick = async () => {
  if (timer) return stop(); if (busy) return;
  setBusy(true); message('');
  try {
    const list = active(); await Promise.all(list.map(f => new Promise((resolve,reject) => { const i = new Image(); i.onload = resolve; i.onerror = () => reject(new Error('Could not load a frame. Refresh and try again.')); i.src = imageUrl(f.path); })));
    archived = false; selected = list[0].id; render();
    let index = 0; timer = setInterval(() => { selected = list[++index % list.length].id; renderSelection(); }, 1000 / 6);
    $('admin-play').innerHTML = pauseSVG; $('admin-play').setAttribute('aria-label', 'Pause movie');
  } catch(e) { message(e.message); } finally { setBusy(false); }
};
async function fillProjects(preferred) {
  const list=await listProjects(), current=preferred || Number($('admin-project').value) || list[0]?.id;
  $('admin-project').replaceChildren(...list.map(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name;return o;}));
  $('admin-project').value=current;selectProject(current);
}
$('admin-project').onchange=async()=>{stop();setBusy(true);selected=null;archived=false;selectProject($('admin-project').value);try{await refresh();message('');}catch(e){message(e.message);}finally{setBusy(false);}};
$('create-project-form').onsubmit=async e=>{e.preventDefault();stop();setBusy(true);try{const id=await createProject($('project-name').value.trim());$('project-name').value='';await fillProjects(id);selected=null;archived=false;await refresh();message('Movie created · 90 frames / 15 seconds.');}catch(e){message(e.message);}finally{setBusy(false);}};
$('clear-movie').onclick=()=>{if(confirm('Clear this movie? All its submitted frames move to Archive and all current bookings are released. You can restore archived drawings later.'))mutate('clear');};
(async () => { setBusy(true); try { if (await session()) await openEditor(); } catch(e) { message(e.message); } finally { setBusy(false); } })();
