import { api, chooseProject, listen, sendDraft, readDrafts, isLive, pollInterval } from './backend.js?v=0.4.0';
const $=id=>document.getElementById(id),canvas=$('drawing'),ctx=canvas.getContext('2d'),onion=$('onion').getContext('2d');
const emptyState=()=>({count:0,frames:[],reservations:[],booking:null,revision:0});
let state=emptyState(),selected=0,tool='pen',drawing=false,editing=false,busy=false,playback=null,history=[],future=[],images=new Map(),renderToken=0,draft=null;
let liveDrafts=new Map(),overlayToken=0,draftDirty=false,draftSending=false,refreshing=false,pendingRefresh=false,projectEpoch=0,ready=false;
let artistName='', nameChosen=false;
try{const saved=localStorage.getItem('sixfps-artist-name');if(saved!==null){artistName=saved.slice(0,40);nameChosen=true;}}catch{}
let nameResolve=null;
function askName(){
 if(nameResolve)return Promise.resolve(false);
 $('artist-name').value=artistName;
 $('name-dialog').showModal();$('artist-name').focus();
 return new Promise(resolve=>{nameResolve=resolve;});
}
$('name-form').onsubmit=e=>{
 e.preventDefault();artistName=$('artist-name').value.trim().slice(0,40);nameChosen=true;
 try{localStorage.setItem('sixfps-artist-name',artistName);}catch{}
 const resolve=nameResolve;nameResolve=null;$('name-dialog').close();update();resolve?.(true);
};
$('name-cancel').onclick=()=>$('name-dialog').close();
$('name-dialog').addEventListener('close',()=>{if(nameResolve){const resolve=nameResolve;nameResolve=null;resolve(false);}});
$('edit-name').onclick=()=>askName();
const blank=()=>ctx.clearRect(0,0,540,960);
const submitted=n=>state.frames.some(f=>f.slot===n);
const highest=()=>Math.max(0,...state.frames.map(f=>f.slot));
const ownSlot=()=>state.booking?.slot||0;
const secondsLeft=booking=>Math.max(0,Math.ceil((Number(booking?.expiresAt||0)-Date.now())/1000));
const activeTurn=()=>!!state.booking&&secondsLeft(state.booking)>0;
function countdown(){
 const slot=editing?ownSlot():selected;
 const booking=state.booking?.slot===slot?state.booking:state.reservations.find(b=>b.slot===slot);
 const badge=$('booking-countdown');badge.hidden=!booking;
 if(booking){const seconds=secondsLeft(booking);badge.textContent=`${seconds}s`;badge.setAttribute('aria-label',`${seconds} seconds remaining`);}
}
function toast(message){$('toast').textContent=message;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').textContent='',6000);}
async function imageAt(n){if(!images.has(n))images.set(n,api(`frames/${n}`).then(data=>data.image?loadImage(data.image):null).catch(e=>{images.delete(n);throw e;}));return images.get(n);}
function loadImage(src){return new Promise((resolve,reject)=>{const i=new Image();i.crossOrigin='anonymous';i.onload=()=>resolve(i);i.onerror=()=>reject(new Error('Could not load frame.'));i.src=src;});}
function stop(){clearInterval(playback);playback=null;$('play').innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v14l11-7z"/></svg>';$('play').setAttribute('aria-label','Play movie');}
function update(){
 countdown();
 const credit=state.frames.find(f=>f.slot===selected)?.artistName;
 $('frame-credit').hidden=editing||!credit;$('frame-credit').textContent=credit?`by ${credit}`:'';
 $('edit-name').hidden=!editing;$('edit-name').textContent=artistName||'Your name';
 const mine=activeTurn(),available=state.frames.length+state.reservations.length<90;
 $('book').disabled=busy||!ready||(!mine&&(!available||state.complete));$('book').textContent=mine?'↗':'+';$('book').setAttribute('aria-label',mine?'Return to your drawing':'Book next available frame');
 $('publish').hidden=!mine;$('release').hidden=!mine;$('publish').disabled=busy||!editing||!history.length;$('release').disabled=busy;
 $('project-select').disabled=busy;
 $('booking-status').textContent=state.complete?'Complete':mine?`Frame ${ownSlot()}`:'';
 $('canvas-title').textContent=String(editing?ownSlot():selected).padStart(3,'0')+(editing?' / DRAW':!submitted(selected)&&liveDrafts.has(selected)?' / LIVE':'');
 $('progress').textContent=`${state.count}/90 · ${(state.count/6).toFixed(1)}/15s`;
 $('scrubber').max=90;$('scrubber').value=selected||ownSlot()||1;$('scrubber').disabled=!state.frames.length&&!state.reservations.length;
 $('position').textContent=`${String(editing?ownSlot():selected).padStart(3,'0')} / 090`;
 $('play').disabled=busy||!state.count;$('undo').disabled=!editing||!history.length;$('redo').disabled=!editing||!future.length;
 canvas.style.cursor=editing?'crosshair':'default';
 document.querySelectorAll('.frame[data-index]').forEach(el=>el.classList.toggle('selected',Number(el.dataset.index)===(editing?ownSlot():selected)));
}
function fit(context,image){context.save();context.filter='grayscale(1)';const scale=Math.min(540/image.width,960/image.height);context.drawImage(image,(540-image.width*scale)/2,(960-image.height*scale)/2,image.width*scale,image.height*scale);context.restore();}
async function overlay(){
 const token=++overlayToken;onion.clearRect(0,0,540,960);if(!editing||ownSlot()<2)return;
 const prev=ownSlot()-1;let image;
 if(submitted(prev))image=await imageAt(prev);else if(liveDrafts.has(prev))image=await loadImage(liveDrafts.get(prev));
 if(token===overlayToken&&editing&&image)fit(onion,image);
}
async function show(n){
 const token=++renderToken;if(editing)draft=canvas.toDataURL();editing=false;selected=n;++overlayToken;onion.clearRect(0,0,540,960);blank();update();
 const image=submitted(n)?await imageAt(n):liveDrafts.has(n)?await loadImage(liveDrafts.get(n)):null;
 if(token===renderToken&&image)fit(ctx,image);
}
async function resume(){if(!activeTurn())return;stop();const token=++renderToken;editing=true;selected=ownSlot();blank();if(draft){const img=await loadImage(draft);if(token===renderToken)ctx.drawImage(img,0,0,540,960);}await overlay();update();}
async function strip(){
 const el=$('filmstrip');el.replaceChildren();
 for(let n=1;n<=90;n++){
  const reserved=state.reservations.some(b=>b.slot===n),button=document.createElement('button');button.className='frame'+(!submitted(n)?reserved?' reserved':' empty':'');button.dataset.index=n;
  button.setAttribute('aria-label',`Frame ${n}${reserved?' being drawn':!submitted(n)?' empty':''}`);
  button.onclick=()=>{stop();(n===ownSlot()?resume():show(n)).catch(e=>toast(e.message));};
  const label=document.createElement('span');label.textContent=String(n).padStart(3,'0')+(reserved?' •':'');button.append(label);el.append(button);
  if(submitted(n))imageAt(n).then(img=>{if(img){const thumb=img.cloneNode();thumb.alt='';button.prepend(thumb);}}).catch(()=>{});
  else if(liveDrafts.has(n)){const img=document.createElement('img');img.src=liveDrafts.get(n);img.alt='';button.prepend(img);}
 }
 update();
}
async function refresh(){
 if(!ready)return;if(refreshing||busy||drawing){pendingRefresh=true;return;}refreshing=true;const epoch=projectEpoch;
 try{
  const previous=state,next=await api('state');if(epoch!==projectEpoch)return;state=next;
  const changed=JSON.stringify(previous.frames)!==JSON.stringify(state.frames);
  let removedDraft=false;for(const n of liveDrafts.keys())if(!state.reservations.some(b=>b.slot===n)||submitted(n)){liveDrafts.delete(n);removedDraft=true;}
  if(removedDraft&&editing)await overlay();
  if(previous.booking&&!state.booking){if(editing)draft=canvas.toDataURL();editing=false;toast('Your turn ended. Your drawing is kept in this tab.');await show(highest());}
  if(changed){stop();images.clear();if(editing)await overlay();else await show(selected||highest());}
  if(state.revision!==previous.revision)await strip();else update();
 }finally{refreshing=false;}
}
async function book(){
 if(busy)return;if(activeTurn())return resume();busy=true;stop();update();
 try{if(!nameChosen&&!(await askName()))return;state=await api('book',{});await resume();await strip();toast(`Frame ${ownSlot()} booked`);}catch(e){toast(e.message);}finally{busy=false;update();}
}
$('book').onclick=book;
$('release').onclick=async()=>{
 if(!confirm('Release your frame? Your draft stays in this tab.'))return;busy=true;update();
 try{if(editing)draft=canvas.toDataURL();state=await api('release',{});editing=false;draftDirty=false;await show(highest());await strip();}catch(e){toast(e.message);}finally{busy=false;update();}
};
$('publish').onclick=async()=>{
 if(busy||!editing||!activeTurn())return;busy=true;update();const slot=ownSlot(),output=document.createElement('canvas');output.width=540;output.height=960;const c=output.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,540,960);c.drawImage(canvas,0,0);
 try{state=await api('frames',{image:output.toDataURL('image/png'),artistName});editing=false;draft=null;draftDirty=false;history=[];future=[];images.clear();await show(slot);await strip();toast(state.complete?'Movie complete · 90 frames · 15 seconds':'Frame submitted');}catch(e){toast(e.message);}finally{busy=false;update();}
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
  if (!editing || busy || !state.booking?.mine || !activeTurn() || e.button !== 0 || drawing) return;
  e.preventDefault(); closeSettings(); saveUndo(); drawing = true; draftDirty = true; canvas.setPointerCapture(e.pointerId);
  ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
  makeStamp(); lastPoint = point(e); dab(...lastPoint); update();
};
canvas.onpointermove = e => {
  if (!drawing) return;
  if(!activeTurn()){endStroke();return;}
  draftDirty = true;
  const events = e.getCoalescedEvents?.();
  for (const p of events?.length ? events : [e]) {
    const next = point(p), dx = next[0] - lastPoint[0], dy = next[1] - lastPoint[1];
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(.5, stampSize * .13)));
    for (let i = 1; i <= steps; i++) dab(lastPoint[0] + dx * i / steps, lastPoint[1] + dy * i / steps);
    lastPoint = next;
  }
};
function endStroke() { if (!drawing) return; drawing = false; ctx.globalCompositeOperation = 'source-over'; draft = canvas.toDataURL(); draftDirty = true; update(); }
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
async function restore(from, to) { if (!editing || busy || !from.length) return; busy = true; to.push(canvas.toDataURL()); const img = await loadImage(from.pop()); blank(); ctx.globalCompositeOperation = 'source-over'; ctx.drawImage(img, 0, 0); draft = canvas.toDataURL(); draftDirty = true; busy = false; update(); }
$('undo').onclick = () => restore(history, future); $('redo').onclick = () => restore(future, history);
function opacity(){$('onion').style.opacity=Number($('opacity').value)/100;$('opacity-value').textContent=`${$('opacity').value}%`;}
$('opacity').oninput=opacity;
$('scrubber').oninput=()=>{stop();show(Number($('scrubber').value)).catch(e=>toast(e.message));};
$('play').onclick=async()=>{
 if(playback)return stop();busy=true;update();
 try{await Promise.all(state.frames.map(f=>imageAt(f.slot)));await show(1);busy=false;update();$('play').innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM15 5h4v14h-4z"/></svg>';$('play').setAttribute('aria-label','Pause movie');const end=highest();playback=setInterval(()=>show(selected%end+1).catch(e=>{stop();toast(e.message);}),1000/6);}catch(e){busy=false;update();toast(e.message);}
};
let scrubDrag=null,suppressClick=false;const filmstrip=$('filmstrip');
filmstrip.onpointerdown=e=>{if(e.button===0)scrubDrag={x:e.clientX,left:filmstrip.scrollLeft,frame:selected||1,moved:false};};
filmstrip.onpointermove=e=>{if(!scrubDrag)return;const delta=e.clientX-scrubDrag.x;if(!scrubDrag.moved&&Math.abs(delta)<5)return;scrubDrag.moved=true;filmstrip.setPointerCapture(e.pointerId);stop();filmstrip.scrollLeft=scrubDrag.left+delta;const step=filmstrip.querySelector('.frame').getBoundingClientRect().width+6,n=Math.max(1,Math.min(90,scrubDrag.frame+Math.round(delta/step)));if(n!==selected||editing)show(n).catch(e=>toast(e.message));};
function endScrub(){suppressClick=!!scrubDrag?.moved;scrubDrag=null;setTimeout(()=>suppressClick=false,0);}filmstrip.onpointerup=endScrub;filmstrip.onpointercancel=endScrub;
filmstrip.addEventListener('click',e=>{if(suppressClick){e.preventDefault();e.stopImmediatePropagation();}},true);
async function switchProject(id){
 busy=true;ready=false;++projectEpoch;stop();update();draft=null;history=[];future=[];editing=false;draftDirty=false;liveDrafts.clear();images.clear();state=emptyState();selected=0;blank();onion.clearRect(0,0,540,960);
 try{await chooseProject(id);state=await api('state');ready=true;await strip();await show(highest());if(state.booking){draft=liveDrafts.get(ownSlot())||null;if(draft)history.push(document.createElement('canvas').toDataURL());await resume();}const url=new URL(location.href);url.searchParams.set('movie',id);window.history.replaceState(null,'',url);}finally{busy=false;update();}
}
$('project-select').onchange=async()=>{
 const next=Number($('project-select').value),previous=state.id;
 if(state.booking){if(!confirm('Switch movies and release your frame? The unpublished drawing in this tab will be discarded.')){$('project-select').value=previous;return;}try{await api('release',{});}catch(e){$('project-select').value=previous;toast(e.message);return;}}
 switchProject(next).catch(e=>toast(e.message));
};
listen(()=>{pendingRefresh=true;},(slot,image)=>{
 liveDrafts.set(slot,image);
 const card=filmstrip.querySelector(`[data-index="${slot}"]`);if(card&&!submitted(slot)){let img=card.querySelector('img');if(!img){img=document.createElement('img');img.alt='';card.prepend(img);}img.src=image;}
 if(editing&&slot===ownSlot()-1)overlay().catch(()=>{});
 else if(!editing&&selected===slot&&!submitted(slot))show(slot).catch(()=>{});
},live=>{$('live-status').textContent=live?'LIVE':'CONNECTING';});
// Throttled snapshots while the pointer moves; only the booking owner can write them.
setInterval(async()=>{
 if(!ready||!editing||!activeTurn()||!draftDirty||draftSending||busy)return;
 draftSending=true;draftDirty=false;
 const preview=document.createElement('canvas');preview.width=270;preview.height=480;preview.getContext('2d').drawImage(canvas,0,0,270,480);
 try{await sendDraft(preview.toDataURL('image/png'));}catch(e){draftDirty=true;$('live-status').textContent='RETRYING';}finally{draftSending=false;}
},750);
setInterval(()=>{if(pendingRefresh&&!busy&&!drawing&&ready){pendingRefresh=false;refresh().catch(e=>toast(e.message));}},500);
setInterval(()=>{if(document.visibilityState==='visible'&&ready){refresh().catch(()=>{});if(!isLive())readDrafts().catch(()=>{});}},pollInterval);
function tickCountdown(){
 countdown();
 if(state.booking&&!activeTurn()){
  if(drawing)endStroke();
  if(editing){draft=canvas.toDataURL();editing=false;toast('Time’s up. Your drawing is kept in this tab.');}
  pendingRefresh=true;update();
 }
}
setInterval(tickCountdown,250);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){tickCountdown();pendingRefresh=true;}});
window.addEventListener('beforeunload',e=>{if(draft&&state.booking){e.preventDefault();e.returnValue='';}});
(async()=>{try{const projects=await api('projects');$('project-select').replaceChildren(...projects.map(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name;return o;}));if(!projects.length)throw new Error('No movies yet. Ask the admin to create one.');const requested=Number(new URL(location.href).searchParams.get('movie')),id=projects.find(p=>p.id===requested)?.id||projects[0].id;$('project-select').value=id;await switchProject(id);}catch(e){toast(e.message);}})();
