/* Small shared helpers. No dependencies. */

export const $ = id => document.getElementById(id);

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

export const num = n => (n ?? 0).toLocaleString();

/**
 * Parse a feed date.
 *
 * Every date in this app is a calendar day, and `new Date('2026-06-18')` is
 * UTC midnight -- which `toLocaleDateString` then renders as the 17th for
 * anyone west of Greenwich. Building it from the parts keeps the day the
 * sources actually reported.
 */
function parseDay(iso){
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso).trim());
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(iso);
}

/** How long ago, in words -- or '' once "N days ago" stops being useful. */
export function when(iso){
  if(!iso) return '';
  const then = parseDay(iso);
  if(isNaN(then)) return '';

  const days = Math.round((startOfToday() - then.getTime()) / 86400000);
  if(days < 0)   return '';
  if(days === 0) return 'today';
  if(days === 1) return 'yesterday';
  if(days < 45)  return `${days} days ago`;
  if(days < 365) return `${Math.round(days / 30)} months ago`;
  return '';
}

function startOfToday(){
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "2026-06-18 (3 days ago)", or just the date when that adds nothing. */
export function dateLabel(iso){
  if(!iso) return null;
  const ago = when(iso);
  return ago ? `${iso} (${ago})` : String(iso);
}

/* ---------- status pill ---------- */
let statusTimer;
export function say(msg, kind){
  const el = $('status');
  if(!el) return;
  clearTimeout(statusTimer);
  if(!msg){ el.hidden = true; return; }
  el.textContent = msg;
  el.className = 'status' + (kind === 'err' ? ' err' : '');
  el.hidden = false;
  if(kind !== 'busy') statusTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

/**
 * Fetch JSON while reporting progress.
 *
 * Streaming rather than awaiting res.json() so a slow connection gets a real
 * progress bar instead of a spinner that sits at zero. Falls back cleanly when
 * the body is not a readable stream.
 */
export async function fetchJSON(url, onProgress){
  const res = await fetch(url);
  if(!res.ok) throw new Error(`${url}: HTTP ${res.status}`);

  const total = +res.headers.get('content-length') || 0;
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if(!reader || !total){
    onProgress?.(1);
    return res.json();
  }

  const chunks = [];
  let got = 0;
  for(;;){
    const { done, value } = await reader.read();
    if(done) break;
    chunks.push(value);
    got += value.length;
    // content-length is the compressed size while `got` counts decompressed
    // bytes, so this overshoots on a gzipped response. Clamping is enough --
    // the bar only has to move.
    onProgress?.(Math.min(0.98, got / total));
  }

  const joined = new Uint8Array(got);
  let at = 0;
  for(const c of chunks){ joined.set(c, at); at += c.length; }
  onProgress?.(1);
  return JSON.parse(new TextDecoder().decode(joined));
}

/* ---------- remembered layer choices ---------- */
const STORE = 'prm.layers.v1';

export function loadPrefs(){
  try{
    return JSON.parse(localStorage.getItem(STORE) || '{}');
  }catch{
    return {};        // private mode, or a corrupt value
  }
}

export function savePrefs(prefs){
  try{
    localStorage.setItem(STORE, JSON.stringify(prefs));
  }catch{
    /* storage disabled; the session still works, it just will not be remembered */
  }
}
