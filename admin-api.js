import config from './config.js';
let sb, projectId = 1;
export async function client() {
  if (!config.url) throw new Error('Open the cloud preview to use the admin editor: SIXFPS_BACKEND=supabase npm start');
  if (!sb) {
    const { createClient } = await import('./vendor/supabase.js');
    sb = createClient(config.url, config.publishableKey, { auth: {
      storageKey: 'sixfps-admin-session', storage: window.sessionStorage,
      persistSession: true, detectSessionInUrl: false,
    } });
  }
  return sb;
}
function checked(result) {
  if (result.error) {
    if (result.error.code === 'PGRST202') throw new Error('Admin setup needed. Run the database setup SQL supplied with this update in Supabase.');
    throw new Error(result.error.message);
  }
  return result.data;
}
export async function session() { return checked(await (await client()).auth.getSession()).session; }
export async function login(email, password) {
  checked(await (await client()).auth.signInWithPassword({ email, password }));
  if (!checked(await sb.rpc('sixfps_is_admin'))) {
    await sb.auth.signOut({ scope: 'local' });
    throw new Error('This account does not have admin access.');
  }
}
export async function logout() { checked(await (await client()).auth.signOut({ scope: 'local' })); }
export async function listProjects() { return checked(await (await client()).from('sixfps_movie').select('id,name,frame_count').order('created_at')); }
export function selectProject(id) { projectId = Number(id); }
export async function createProject(name) { const id = checked(await (await client()).rpc('sixfps_project_create', { p_name: name })); projectId=id; return id; }
export async function loadMovie() { return checked(await (await client()).rpc('sixfps_project_admin_state', { p_project: projectId })); }
export function imageUrl(path) { return sb.storage.from('sixfps-frames').getPublicUrl(path).data.publicUrl; }
export async function edit(action, id, position, revision) {
  return checked(await (await client()).rpc('sixfps_project_edit', {
    p_project: projectId,
    action, frame_id: id, target_position: position, expected_revision: revision,
  }));
}
export async function deleteFrame(frame, revision) {
  const prepared = await edit('prepare_delete', frame.id, null, revision);
  // Deliberately use Storage API, never delete storage.objects through SQL.
  checked(await sb.storage.from('sixfps-frames').remove([frame.path]));
  return edit('finish_delete', frame.id, null, prepared.movie.revision);
}

export async function deleteProject(revision) {
 return checked(await (await client()).rpc('sixfps_project_delete', {p_project:projectId, expected_revision:revision}));
}
export async function cleanupProjects() {
 const c=await client();
 while(true){
  const rows=checked(await c.from('sixfps_project_cleanup').select('path').limit(100));
  if(!rows.length)return;
  const paths=rows.map(r=>r.path);
  checked(await c.storage.from('sixfps-frames').remove(paths));
  checked(await c.rpc('sixfps_project_cleanup_done',{p_paths:paths}));
 }
}

export async function pendingCleanup() {return checked(await (await client()).from('sixfps_project_cleanup').select('path').limit(1)).length>0;}
