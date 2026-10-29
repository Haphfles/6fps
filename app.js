import { api, chooseProject, listen, sendDraft, readDrafts, isLive, pollInterval, publicImage } from './backend.js?v=0.6.0';
import { exportMovie, validateMovieFrames } from './video-export.js?v=0.6.0';
const $=id=>document.getElementById(id),canvas=$('drawing'),ctx=canvas.getContext('2d'),onion=$('onion').getContext('2d');
const emptyState=()=>({count:0,frames:[],reservations:[],booking:null,revision:0});
let state=emptyState(),selected=0,tool='round',drawing=false,editing=false,busy=false,playback=null,history=[],future=[],images=new Map(),renderToken=0,draft=null;
let liveDrafts=new Map(),overlayToken=0,draftDirty=false,draftSending=false,refreshing=false,pendingRefresh=false,projectEpoch=0,ready=false;
let previewImages=new Map(),stripGeneration=0,exportController=null,exportUrl=null;
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
const blank=()=>ctx.clearRect(0,0,1080,1920);
const submitted=n=>state.frames.some(f=>f.slot===n);
const highest=()=>Math.max(0,...state.frames.map(f=>f.slot));
const ownSlot=()=>state.booking?.slot||0;
const secondsLeft=booking=>Math.max(0,Math.ceil((Number(booking?.expiresAt||0)-Date.now())/1000));
const activeTurn=()=>!!state.booking&&secondsLeft(state.booking)>0;
function countdown(){
 const turns=new Map(state.reservations.map(b=>[b.slot,b]));
 if(state.booking)turns.set(state.booking.slot,state.booking);
 document.querySelectorAll('.frame-countdown').forEach(badge=>{
  const slot=Number(badge.dataset.slot),booking=turns.get(slot);
  badge.hidden=!booking;
  if(booking){const seconds=secondsLeft(booking);badge.textContent=`${seconds}s`;badge.parentElement.setAttribute('aria-label',`Frame ${slot} being drawn, ${seconds} seconds remaining`);}
 });
}
function revealBookedFrame(){
 const card=$('filmstrip').querySelector(`[data-index="${ownSlot()}"]`);
 if(card)card.scrollIntoView({block:'nearest',inline:'nearest'});
}
function toast(message){$('toast').textContent=message;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').textContent='',6000);}
async function imageAt(n){
 if(!images.has(n)){
  const request=api(`frames/${n}`).then(data=>data.image?loadImage(data.image):null).catch(e=>{images.delete(n);throw e;});
  images.set(n,request);
  // Keep only a few decoded full-HD images in memory, especially on phones.
  while(images.size>4)images.delete(images.keys().next().value);
 }
 const value=images.get(n);images.delete(n);images.set(n,value);return value;
}
async function previewAt(n){
 if(!previewImages.has(n))previewImages.set(n,(async()=>{
  const full=await imageAt(n);if(!full)return null;
  const small=document.createElement('canvas');small.width=270;small.height=480;
  small.getContext('2d').drawImage(full,0,0,270,480);
  return loadImage(small.toDataURL('image/png'));
 })().catch(e=>{previewImages.delete(n);throw e;}));
 return previewImages.get(n);
}
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
 $('export-video').hidden=!state.complete||state.frames.length!==90;$('export-video').disabled=busy;
 $('size').disabled=busy;$('colour').disabled=busy;document.querySelectorAll('[data-tool]').forEach(b=>b.disabled=busy);
 $('booking-status').textContent=state.complete?'Complete':mine?`Frame ${ownSlot()}`:'';
 $('canvas-title').textContent=String(editing?ownSlot():selected).padStart(3,'0')+(editing?' / DRAW':!submitted(selected)&&liveDrafts.has(selected)?' / LIVE':'');
 $('progress').textContent=`${state.count}/90 · ${(state.count/6).toFixed(1)}/15s`;
 $('scrubber').max=90;$('scrubber').value=selected||ownSlot()||1;$('scrubber').disabled=busy||(!state.frames.length&&!state.reservations.length);
 $('position').textContent=`${String(editing?ownSlot():selected).padStart(3,'0')} / 090`;
 $('play').disabled=busy||(!state.count&&!(activeTurn()&&(draft||history.length))); $('undo').disabled=!editing||!history.length;$('redo').disabled=!editing||!future.length;
 canvas.style.cursor=editing?'crosshair':'default';
 document.querySelectorAll('.frame[data-index]').forEach(el=>el.classList.toggle('selected',Number(el.dataset.index)===(editing?ownSlot():selected)));
}
function fit(context,image){context.save();const scale=Math.min(1080/image.width,1920/image.height);context.drawImage(image,(1080-image.width*scale)/2,(1920-image.height*scale)/2,image.width*scale,image.height*scale);context.restore();}
async function overlay(){
 const token=++overlayToken;onion.clearRect(0,0,1080,1920);if(!editing||ownSlot()<2)return;
 const prev=ownSlot()-1;let image;
 if(submitted(prev))image=await imageAt(prev);else if(liveDrafts.has(prev))image=await loadImage(liveDrafts.get(prev));
 if(token===overlayToken&&editing&&image)fit(onion,image);
}
async function show(n){
 const token=++renderToken;if(editing)draft=canvas.toDataURL();editing=false;selected=n;++overlayToken;onion.clearRect(0,0,1080,1920);blank();update();
 const image=n===ownSlot()&&activeTurn()&&draft?await loadImage(draft):submitted(n)?await (playback?previewAt(n):imageAt(n)):liveDrafts.has(n)?await loadImage(liveDrafts.get(n)):null;
 if(token===renderToken&&image)fit(ctx,image);
}
async function resume(){if(!activeTurn())return;stop();const token=++renderToken;editing=true;selected=ownSlot();blank();if(draft){const img=await loadImage(draft);if(token===renderToken)ctx.drawImage(img,0,0,1080,1920);}await overlay();update();}
async function strip(){
 const el=$('filmstrip'),version=++stripGeneration;el.replaceChildren();
 for(let n=1;n<=90;n++){
  const reserved=state.reservations.some(b=>b.slot===n),button=document.createElement('button');button.className='frame'+(!submitted(n)?reserved?' reserved':' empty':'');button.dataset.index=n;
  button.setAttribute('aria-label',`Frame ${n}${reserved?' being drawn':!submitted(n)?' empty':''}`);
  button.onclick=()=>{if(busy)return;stop();(n===ownSlot()?resume():show(n)).catch(e=>toast(e.message));};
  const label=document.createElement('span');label.textContent=String(n).padStart(3,'0')+(reserved?' •':'');button.append(label);if(reserved||n===ownSlot()){const badge=document.createElement('span');badge.className='frame-countdown';badge.dataset.slot=n;badge.setAttribute('aria-hidden','true');button.append(badge);}el.append(button);
  if(!submitted(n)&&liveDrafts.has(n)){const img=document.createElement('img');img.src=liveDrafts.get(n);img.alt='';button.prepend(img);}
 }
 update();
 // Decode full-resolution frames one at a time; keep small timeline/playback previews.
 (async()=>{for(const frame of state.frames){if(version!==stripGeneration)return;try{
  const img=await previewAt(frame.slot);if(version!==stripGeneration)return;
  const button=el.querySelector(`[data-index="${frame.slot}"]`);
  if(button&&img){const thumb=img.cloneNode();thumb.alt='';button.prepend(thumb);}
 }catch{}}})();
}
async function refresh(){
 if(!ready)return;if(refreshing||busy||drawing){pendingRefresh=true;return;}refreshing=true;const epoch=projectEpoch;
 try{
  const previous=state,next=await api('state');if(epoch!==projectEpoch)return;state=next;
  const changed=JSON.stringify(previous.frames)!==JSON.stringify(state.frames);
  let removedDraft=false;for(const n of liveDrafts.keys())if(!state.reservations.some(b=>b.slot===n)||submitted(n)){liveDrafts.delete(n);removedDraft=true;}
  if(removedDraft&&editing)await overlay();
  if(previous.booking&&!state.booking){if(editing)draft=canvas.toDataURL();editing=false;toast('Your turn ended. Your drawing is kept in this tab.');await show(highest());}
  if(changed){stop();images.clear();previewImages.clear();if(editing)await overlay();else await show(selected||highest());}
  if(state.revision!==previous.revision)await strip();else update();
 }finally{refreshing=false;}
}
async function book(){
 if(busy)return;if(activeTurn()){await resume();revealBookedFrame();return;}busy=true;stop();update();
 try{if(!nameChosen&&!(await askName()))return;state=await api('book',{});await resume();await strip();revealBookedFrame();toast(`Frame ${ownSlot()} booked`);}catch(e){toast(e.message);}finally{busy=false;update();}
}
$('book').onclick=book;
$('release').onclick=async()=>{
 if(!confirm('Release your frame? Your draft stays in this tab.'))return;busy=true;update();
 try{if(editing)draft=canvas.toDataURL();state=await api('release',{});editing=false;draftDirty=false;await show(highest());await strip();}catch(e){toast(e.message);}finally{busy=false;update();}
};
$('publish').onclick=async()=>{
 if(busy||!editing||!activeTurn())return;busy=true;update();const slot=ownSlot(),output=document.createElement('canvas');output.width=1080;output.height=1920;const c=output.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,1080,1920);c.drawImage(canvas,0,0);
 try{state=await api('frames',{image:output.toDataURL('image/png'),artistName});editing=false;draft=null;draftDirty=false;history=[];future=[];images.clear();previewImages.clear();await show(slot);await strip();toast(state.complete?'Movie complete · 90 frames · 15 seconds':'Frame submitted');}catch(e){toast(e.message);}finally{busy=false;update();}
};
function point(e) { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * 1080 / r.width, (e.clientY - r.top) * 1920 / r.height]; }
function saveUndo() { history.push(canvas.toDataURL()); if (history.length > 30) history.shift(); future = []; }
let lastPoint=null,strokeSize=12,strokeColour='#000000',strokeShape='round';
function startMark(x,y){if(strokeShape==='square'){ctx.fillRect(x-strokeSize/2,y-strokeSize/2,strokeSize,strokeSize);}else{ctx.beginPath();ctx.arc(x,y,strokeSize/2,0,Math.PI*2);ctx.fill();}}
canvas.onpointerdown=e=>{
 if(!editing||busy||!state.booking?.mine||!activeTurn()||e.button!==0||drawing)return;
 e.preventDefault();saveUndo();drawing=true;draftDirty=true;canvas.setPointerCapture(e.pointerId);
 strokeSize=Number($('size').value);strokeColour=$('colour').value;strokeShape=tool;
 ctx.globalCompositeOperation=tool==='eraser'?'destination-out':'source-over';
 ctx.fillStyle=strokeColour;ctx.strokeStyle=strokeColour;ctx.lineWidth=strokeSize;ctx.lineCap='round';ctx.lineJoin='round';
 lastPoint=point(e);startMark(...lastPoint);update();
};
canvas.onpointermove=e=>{
 if(!drawing)return;if(!activeTurn()){endStroke();return;}draftDirty=true;
 const events=e.getCoalescedEvents?.();
 for(const p of events?.length?events:[e]){
  const next=point(p);
  if(strokeShape==='square'){
   const dx=next[0]-lastPoint[0],dy=next[1]-lastPoint[1],steps=Math.max(1,Math.ceil(Math.hypot(dx,dy)/Math.max(1,strokeSize*.1)));
   for(let i=1;i<=steps;i++)startMark(lastPoint[0]+dx*i/steps,lastPoint[1]+dy*i/steps);
  }else{ctx.beginPath();ctx.moveTo(...lastPoint);ctx.lineTo(...next);ctx.stroke();}
  lastPoint=next;
 }
};
function endStroke(){if(!drawing)return;drawing=false;ctx.globalCompositeOperation='source-over';draft=canvas.toDataURL();draftDirty=true;update();}
canvas.onpointerup=endStroke;canvas.onpointercancel=endStroke;canvas.onlostpointercapture=endStroke;
document.querySelectorAll('[data-tool]').forEach(button=>button.onclick=()=>{
 if(drawing)return;tool=button.dataset.tool;
 document.querySelectorAll('[data-tool]').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));});
});
function updateBrushPreview(){
 const size=Number($('size').value),diameter=Math.max(3,size*canvas.getBoundingClientRect().width/canvas.width);
 $('size').style.setProperty('--brush-diameter',`${diameter}px`);
 $('size').setAttribute('aria-valuetext',`${size} pixels`);
}
$('size').oninput=updateBrushPreview;
new ResizeObserver(updateBrushPreview).observe(canvas);
updateBrushPreview();
async function restore(from, to) { if (!editing || busy || !from.length) return; busy = true; to.push(canvas.toDataURL()); const img = await loadImage(from.pop()); blank(); ctx.globalCompositeOperation = 'source-over'; ctx.drawImage(img, 0, 0); draft = canvas.toDataURL(); draftDirty = true; busy = false; update(); }
$('undo').onclick = () => restore(history, future); $('redo').onclick = () => restore(future, history);
function opacity(){$('onion').style.opacity=Number($('opacity').value)/100;$('opacity-value').textContent=`${$('opacity').value}%`;}
$('opacity').oninput=opacity;
$('scrubber').oninput=()=>{stop();show(Number($('scrubber').value)).catch(e=>toast(e.message));};
$('play').onclick=async()=>{
 if(playback){stop();if(activeTurn()&&draft)await resume();else update();return;}
 if(busy)return;
 if(drawing)endStroke();
 if(editing)draft=canvas.toDataURL();
 busy=true;update();
 try{for(const frame of state.frames)await previewAt(frame.slot);await show(1);busy=false;update();$('play').innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM15 5h4v14h-4z"/></svg>';$('play').setAttribute('aria-label','Pause movie');const end=Math.max(highest(),activeTurn()&&draft?ownSlot():0);playback=setInterval(()=>show(selected%end+1).catch(e=>{stop();toast(e.message);}),1000/6);}catch(e){busy=false;update();toast(e.message);}
};
let scrubDrag=null,suppressClick=false;const filmstrip=$('filmstrip');
filmstrip.onpointerdown=e=>{if(!busy&&e.button===0)scrubDrag={x:e.clientX,left:filmstrip.scrollLeft,frame:selected||1,moved:false};};
filmstrip.onpointermove=e=>{if(!scrubDrag)return;const delta=e.clientX-scrubDrag.x;if(!scrubDrag.moved&&Math.abs(delta)<5)return;scrubDrag.moved=true;filmstrip.setPointerCapture(e.pointerId);stop();filmstrip.scrollLeft=scrubDrag.left+delta;const step=filmstrip.querySelector('.frame').getBoundingClientRect().width+6,n=Math.max(1,Math.min(90,scrubDrag.frame+Math.round(delta/step)));if(n!==selected||editing)show(n).catch(e=>toast(e.message));};
function endScrub(){suppressClick=!!scrubDrag?.moved;scrubDrag=null;setTimeout(()=>suppressClick=false,0);}filmstrip.onpointerup=endScrub;filmstrip.onpointercancel=endScrub;
filmstrip.addEventListener('click',e=>{if(suppressClick){e.preventDefault();e.stopImmediatePropagation();}},true);
async function switchProject(id){
 busy=true;ready=false;++projectEpoch;stop();update();draft=null;history=[];future=[];editing=false;draftDirty=false;liveDrafts.clear();images.clear();previewImages.clear();state=emptyState();selected=0;blank();onion.clearRect(0,0,1080,1920);
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

$('export-video').onclick=async()=>{
 if(busy)return;
 try{validateMovieFrames(state.frames);}catch(e){toast(e.message);return;}
 busy=true;stop();update();const snapshot=state.frames.map(f=>({...f}));
 exportController=new AbortController();$('export-download').hidden=true;$('export-progress').hidden=false;$('export-progress').value=0;$('export-status').textContent='Preparing…';$('export-close').textContent='Cancel';$('export-dialog').showModal();
 if(exportUrl){URL.revokeObjectURL(exportUrl);exportUrl=null;}
 try{
  const result=await exportMovie({frames:snapshot,getImage:async slot=>loadImage(await publicImage(snapshot.find(f=>f.slot===slot).path)),signal:exportController.signal,onProgress:n=>{$('export-progress').value=n;$('export-status').textContent=`${n}/90`;}});
  exportUrl=URL.createObjectURL(result.blob);const link=$('export-download');link.href=exportUrl;
  link.download=`${(state.name||'6FPS').replace(/[^a-z0-9_-]/gi,'-').slice(0,60)}-1080x1920.${result.extension}`;
  link.textContent=`Download ${result.extension.toUpperCase()} ↓`;link.hidden=false;
  $('export-status').textContent='1080 × 1920 · 6 FPS · 15 seconds';
 }catch(e){if(e.name==='AbortError')$('export-dialog').close();else $('export-status').textContent=e.message;}
 finally{exportController=null;busy=false;$('export-close').textContent='Close';update();}
};
$('export-close').onclick=()=>{if(exportController)exportController.abort();else $('export-dialog').close();};
$('export-dialog').addEventListener('cancel',e=>{if(exportController){e.preventDefault();exportController.abort();}});
