/*
   Boot and orchestration.

   Three data layers, each a self-contained module behind the same small
   interface (load / prepare / addLayers / filters / applyFilter / popup).  This
   file owns the map, the loading lifecycle and the stacking order; it does not
   know what any layer draws.
*/

import { $, say, loadPrefs, savePrefs } from './util.js';
import * as panel from './panel.js';
import { wire as wireSearch } from './search.js';
import { buildStyle, applySky, starfield, idleSpin, fitZoom } from './globe.js';

import cameras from './cameras.js';
import disasters from './disasters.js';
import conflicts from './conflicts.js';

const LAYERS = [cameras, disasters, conflicts];
const byId = new Map(LAYERS.map(l => [l.id, l]));

/*
  Painting order, bottom first.  Layers arrive at unpredictable times because
  each loads on demand, so every add is followed by a restack rather than
  relying on insertion order.

  All the glows sit below all the cores, so one layer's soft halo never washes
  out another layer's bright centre -- which is what happened when each layer
  was added as a self-contained glow/core pair.

  Cameras are the bottom of both groups: 148k faint pinpricks are the carpet
  everything else is read against.
*/
const STACK = [
  'cam-glow',
  'conflict-event-glow', 'conflict-bubble-glow',
  'disaster-glow',
  'cam-core',
  'conflict-event-core', 'conflict-bubble-core',
  'disaster-core',
  'conflict-label',
];

// 'off' | 'loading' | 'ready' | 'error'
const state = new Map(LAYERS.map(l => [l.id, 'off']));
const on = new Map();
const stamps = new Map();

const prefs = loadPrefs();
for(const l of LAYERS){
  on.set(l.id, typeof prefs[l.id] === 'boolean' ? prefs[l.id] : l.defaultOn);
}

/** Persist the layer switches plus the "has seen the panel" flag, together. */
function persist(extra){
  Object.assign(prefs, Object.fromEntries(on), extra);
  savePrefs(prefs);
}

/* ---------- map ---------- */
starfield($('stars'));

// Read before the Map exists: `hash: true` writes one immediately.
const deepLinked = Boolean(location.hash);

const map = new maplibregl.Map({
  container: 'map',
  style: buildStyle(),
  center: [10, 25],
  zoom: fitZoom(),
  minZoom: 0.6,             // below this the globe floats in a sea of chrome
  attributionControl: false,
  hash: true,               // shareable deep links: #zoom/lat/lon
});

// MapLibre only re-measures on window resize.  Mobile browser chrome sliding
// away, an orientation change, or the page being revealed after loading hidden
// all resize the container without one, leaving a stretched canvas.
if(window.ResizeObserver){
  new ResizeObserver(() => map.resize()).observe($('map'));
}

// The compass earns its place on a globe: dragging can roll the planet, and
// this is how you get north back.
map.addControl(new maplibregl.NavigationControl({ visualizePitch:true }), 'bottom-right');
map.addControl(new maplibregl.GeolocateControl({
  positionOptions:{ enableHighAccuracy:true },
  trackUserLocation:false,
}), 'bottom-right');
map.addControl(new maplibregl.AttributionControl({ compact:true }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ maxWidth:90, unit:'imperial' }), 'bottom-left');

/* ---------- layer lifecycle ---------- */

function restack(){
  // Walk top-down and pin each present layer above the one below it, so a
  // late arrival lands in the right place instead of on top of everything.
  for(let i = STACK.length - 1; i > 0; i--){
    const above = STACK[i];
    if(!map.getLayer(above)) continue;
    for(let j = i - 1; j >= 0; j--){
      if(map.getLayer(STACK[j])){ map.moveLayer(STACK[j], above); break; }
    }
  }
}

async function bring(layer, onProgress){
  if(state.get(layer.id) !== 'off') return;
  state.set(layer.id, 'loading');

  try{
    const meta = await layer.load(onProgress);
    await layer.prepare?.(map);
    layer.addLayers(map);
    restack();
    layer.applyFilter(map, on.get(layer.id));
    state.set(layer.id, 'ready');
    if(meta?.generated) stamps.set(layer.id, meta.generated.slice(0, 10));
    stamp();
    return meta;
  }catch(err){
    state.set(layer.id, 'error');
    console.error(`${layer.id}: ${err.message}`, err);
    throw err;
  }
}

function setVisible(layer, visible){
  for(const id of layer.layerIds){
    if(map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
  // Layers with sub-toggles of their own need the last word on visibility.
  if(visible) layer.applyFilter(map, true);
}

/** The badge on the Layers button: how many of the three are switched on. */
function badge(){
  $('panel-count').textContent = String([...on.values()].filter(Boolean).length);
}

async function setLayer(id, want){
  const layer = byId.get(id);
  on.set(id, want);
  persist();
  badge();
  stamp();

  if(!want){
    if(state.get(id) === 'ready') setVisible(layer, false);
    panel.render();
    return;
  }

  if(state.get(id) === 'ready'){
    setVisible(layer, true);
    panel.render();
    return;
  }

  // A layer that failed earlier gets a clean slate, so switching it back on
  // actually retries the fetch instead of reporting the old failure forever.
  if(state.get(id) === 'error') state.set(id, 'off');

  // First time on: fetch it now. `bring` flips the state to 'loading'
  // synchronously, so start it before rendering to get the spinner text.
  say(`Loading ${layer.label.toLowerCase()}…`, 'busy');
  const pending = bring(layer, () => {});
  panel.render();

  try{
    if(await pending) setVisible(layer, true);
    say(`${layer.label}: ${layer.summary()}.`);
  }catch{
    say(`Couldn’t load ${layer.label.toLowerCase()}.`, 'err');
  }
  panel.render();
}

/* ---------- popups ---------- */

function wirePopups(){
  const interactive = LAYERS.flatMap(l => l.interactive);

  map.on('click', e => {
    const hits = map.queryRenderedFeatures(e.point, {
      layers: interactive.filter(id => map.getLayer(id)),
    });
    if(!hits.length) return;

    const f = hits[0];
    const owner = LAYERS.find(l => l.interactive.includes(f.layer.id));
    const html = owner?.popup(f);
    if(!html) return;

    new maplibregl.Popup({ closeButton:true, maxWidth:'300px' })
      .setLngLat(f.geometry.coordinates)
      .setHTML(html)
      .addTo(map);
  });

  map.on('mousemove', e => {
    const hits = map.queryRenderedFeatures(e.point, {
      layers: interactive.filter(id => map.getLayer(id)),
    });
    map.getCanvas().style.cursor = hits.length ? 'pointer' : '';
  });
}

/* ---------- footer stamp ---------- */
function stamp(){
  const parts = LAYERS
    .filter(l => stamps.has(l.id) && on.get(l.id))
    .map(l => `${l.label.toLowerCase()} ${stamps.get(l.id)}`);
  $('stamp').textContent = parts.join(' · ');
}

/* ---------- boot ---------- */
(async function boot(){
  const bootEl = $('boot');

  // Gate on the style, not on 'load'.  'load' waits for a completed render,
  // which a browser never performs in a background tab -- that would leave
  // this overlay up until the visitor focused the tab.  Sources and layers
  // only need the style.
  const styleReady = map.isStyleLoaded()
    ? Promise.resolve()
    : new Promise(res => map.once('style.load', res));

  // Whatever is switched on at boot loads together, sharing one progress bar.
  const wanted = LAYERS.filter(l => on.get(l.id));
  const progress = new Map(wanted.map(l => [l.id, 0]));
  const tick = () => {
    const done = [...progress.values()].reduce((a, b) => a + b, 0) / (progress.size || 1);
    $('boot-bar').style.width = Math.min(99, done * 100) + '%';
  };

  try{
    await styleReady;
    applySky(map);

    const results = await Promise.allSettled(wanted.map(l =>
      bring(l, p => { progress.set(l.id, p); tick(); })
    ));

    wirePopups();
    wireSearch(map);
    panel.init(LAYERS, {
      isOn: id => on.get(id),
      stateOf: id => state.get(id),
      setLayer,
      setFilter: (id, key, val) => {
        const layer = byId.get(id);
        layer.toggleFilter(key, val);
        layer.applyFilter(map, on.get(id));
        panel.render();
      },
      setRange: (id, key) => {
        const layer = byId.get(id);
        layer.setRange(key);
        layer.applyFilter(map, on.get(id));
        panel.render();
      },
    });

    for(const l of wanted){
      if(state.get(l.id) === 'ready') setVisible(l, on.get(l.id));
    }

    const ok = wanted.filter(l => state.get(l.id) === 'ready');
    const failed = wanted.filter(l => state.get(l.id) === 'error');

    // Every layer failing is a dead page; some failing is a degraded one.
    if(!ok.length){
      const why = results.find(r => r.status === 'rejected');
      throw why?.reason || new Error('no layers loaded');
    }

    $('boot-bar').style.width = '100%';
    bootEl.classList.add('gone');
    setTimeout(() => { bootEl.hidden = true; }, 400);

    badge();
    stamp();

    // Drift the planet until somebody grabs it, so the first thing a visitor
    // sees is a globe turning rather than a still image.
    idleSpin(map, { deepLinked });

    // Nothing else on the page advertises that there are two more datasets
    // behind that button, so show a first-time visitor the panel outright.
    // Not on a phone, where it would cover the map it is describing.
    const firstVisit = prefs.seen !== true;
    if(firstVisit && window.innerWidth > 640) panel.setOpen(true);
    persist({ seen:true });

    const idle = LAYERS.filter(l => !on.get(l.id));
    say(failed.length
      ? `${ok.map(l => l.summary()).join(' · ')} — ${failed.map(l => l.label.toLowerCase()).join(' and ')} unavailable.`
      : idle.length
        ? `${ok.map(l => l.summary()).join(' · ')}. Add ${idle.map(l => l.label.toLowerCase()).join(' or ')} from Layers.`
        : ok.map(l => l.summary()).join(' · '),
      failed.length ? 'err' : undefined);
  }catch(err){
    $('boot-msg').textContent = 'Could not load the map data. Please refresh.';
    $('boot-bar').style.display = 'none';
    console.error(err);
  }
})();
