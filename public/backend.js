import config from './config.js';
let clientPromise, project = null, current = null, channel = null, generation = 0;
let onMovie = () => {}, onDraft = () => {}, onConnection = () => {}, connected = false, pending = null;
export async function client() {
 if (!config.url) throw new Error('Projects use Supabase. Start the local preview with SIXFPS_BACKEND=supabase npm start.');
 if (!clientPromise) clientPromise = import('./vendor/supabase.js').then(({createClient}) => createClient(config.url,config.publishableKey));
 return clientPromise;
}
function check(error) {
 if (!error) return;
 if(error.code==='PGRST202'||error.code==='42703') throw new Error('Project setup needed. Run supabase/projects.sql, then refresh.');
 if(/anonymous.*disabled/i.test(error.message)) throw new Error('Enable anonymous sign-ins in Supabase.');
 throw new Error(error.message || 'Connection failed.');
}
async function rpc(name,args={}) { const {data,error}=await (await client()).rpc(name,args);check(error);return data; }
async function identity() {
 const sb=await client(); const {data,error}=await sb.auth.getSession();check(error);
 if(!data.session){const result=await sb.auth.signInAnonymously();check(result.error);}
}
export function listen(movie,draft,status){onMovie=movie;onDraft=draft;onConnection=status;}
export async function chooseProject(id) {
 const sb=await client(); const version=++generation;
 if(channel) await sb.removeChannel(channel);
 project=Number(id);current=null;pending=null;connected=false;onConnection(false);
 channel=sb.channel(`sixfps-project-${project}-${version}`)
  .on('postgres_changes',{event:'UPDATE',schema:'public',table:'sixfps_movie',filter:`id=eq.${project}`},()=>{if(version===generation)onMovie();})
  .on('postgres_changes',{event:'*',schema:'public',table:'sixfps_drafts',filter:`project_id=eq.${project}`},payload=>{
   if(version!==generation)return;
   const row=payload.new;
   if(row?.slot && row.image && new Date(row.expires_at).getTime()>Date.now())onDraft(row.slot,row.image);
   else onMovie();
  }).subscribe(status=>{if(version!==generation)return;connected=status==='SUBSCRIBED';onConnection(connected);if(connected){onMovie();readDrafts().catch(()=>{});}});
 await readDrafts();
}
export async function readDrafts() {
 if(!project)return;const id=project;const {data,error}=await (await client()).from('sixfps_drafts').select('slot,image,expires_at').eq('project_id',id);check(error);
 if(id===project)for(const row of data)onDraft(row.slot,row.image);
}
export async function sendDraft(image) {
 const own=current?.booking;if(!own)return;
 await rpc('sixfps_project_draft',{p_project:project,p_token:own.token,p_image:image});
}
export function isLive(){return connected;}
export async function api(route,body) {
 const sb=await client();
 if(route==='projects'){const {data,error}=await sb.from('sixfps_movie').select('id,name,frame_count').order('created_at');check(error);return data;}
 if(!project)throw new Error('Choose a movie.');
 if(route==='state'){current=await rpc('sixfps_project_state',{p_project:project});if(!current)throw new Error('Movie not found.');return current;}
 if(route.startsWith('frames/')){const f=current?.frames.find(f=>f.slot===Number(route.split('/')[1]));return {image:f?sb.storage.from('sixfps-frames').getPublicUrl(f.path).data.publicUrl:null};}
 await identity();
 if(route==='book'){current=await rpc('sixfps_project_book',{p_project:project});if(pending?.token!==current.booking?.token)pending=null;return current;}
 if(route==='release'){
  if(!current?.booking)throw new Error('Your booking has ended.');
  current=await rpc('sixfps_project_release',{p_project:project,p_token:current.booking.token});pending=null;return current;
 }
 if(route==='frames'){
  if(pending?.uploaded){current=await rpc('sixfps_project_publish',{p_project:project,p_token:pending.token});pending=null;return current;}
  const own=current?.booking;if(!own)throw new Error('Book a frame first.');
  if(!/^data:image\/png;base64,/.test(body.image))throw new Error('Please submit a PNG drawing.');
  const blob=new Blob([Uint8Array.from(atob(body.image.split(',')[1]),c=>c.charCodeAt(0))],{type:'image/png'});
  if(blob.size>2097152)throw new Error('Drawing exceeds 2 MB.');
  pending={token:own.token,uploaded:false};
  const {error}=await sb.storage.from('sixfps-frames').upload(own.path,blob,{contentType:'image/png',upsert:false,cacheControl:'31536000'});
  if(error&&!/already exists|duplicate/i.test(error.message))check(error);
  pending.uploaded=true;current=await rpc('sixfps_project_publish',{p_project:project,p_token:own.token});pending=null;return current;
 }
 throw new Error('Unknown request.');
}
export const pollInterval=10000;
