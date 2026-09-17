/*
   ALPR camera layer.

   Every camera ships as a static file built by scripts/harvest.py, so the page
   makes no data API calls for it at runtime.  That is deliberate: the public
   Overpass instances explicitly forbid being queried from a browser on every
   map move, and would rate-limit visitors of an app that did.

   These are drawn unclustered, all 148,805 of them. Clustering would be the
   obvious choice for this many points and it is the wrong one here: the
   clusters were opaque discs with counts in them, and what makes this layer
   worth looking at on a night globe is the carpet -- the way the individual
   lights pile up into the shape of a metro area on their own.
*/

import { esc, num, fetchJSON } from './util.js';
import { lightLayers } from './lights.js';

const DATA_URL = 'data/cameras.json';

// Brand hues, pushed brighter than the flat-map palette because they now have
// to carry against black rather than against paper.
const BRANDS = [
  { key:'flock',    label:'Flock Safety',        hex:'#FFA53D' },
  { key:'motorola', label:'Motorola / Vigilant', hex:'#54A0FF' },
  { key:'genetec',  label:'Genetec',             hex:'#3FD98B' },
  { key:'elsag',    label:'Leonardo / ELSAG',    hex:'#B98BFF' },
  { key:'other',    label:'Other / unlabelled',  hex:'#8FA6BF' },
];

let rows = [], pools = {}, generated = '';
// Built once and reused. Re-allocating 148k feature objects on every filter
// toggle cost ~340ms on the main thread; filtering the existing array is ~20x
// cheaper because it only copies references.
let allFeatures = [];

const active = new Set(BRANDS.map((_, i) => i));

const pick = (pool, idx) => (idx >= 0 && pools[pool] ? pools[pool][idx] : null);

export default {
  id: 'cameras',
  label: 'ALPR cameras',
  blurb: 'Community-reported plate readers, from OpenStreetMap',
  colour: '#FFA53D',
  defaultOn: true,
  interactive: ['cam-core'],
  layerIds: ['cam-glow', 'cam-core'],

  async load(onProgress){
    const payload = await fetchJSON(DATA_URL, onProgress);
    rows = payload.rows;
    pools = payload.pools;
    generated = payload.generated || '';

    // Properties stay tiny -- b for styling, i to look the rest up on click.
    allFeatures = new Array(rows.length);
    for(let i = 0; i < rows.length; i++){
      const r = rows[i];
      allFeatures[i] = {
        type: 'Feature',
        geometry: { type:'Point', coordinates:[r[1], r[0]] },
        properties: { b: r[2], i },
      };
    }
    return { count: rows.length, generated };
  },

  addLayers(map){
    map.addSource('cams', {
      type: 'geojson',
      data: { type:'FeatureCollection', features: allFeatures },
    });

    // Sub-pixel at world zoom on purpose. Individually invisible, collectively
    // they trace out every lit corridor in North America and Europe.
    const layers = lightLayers({
      idPrefix: 'cam',
      source: 'cams',
      property: 'b',
      stops: BRANDS.map((b, i) => [i, b.hex]),
      fallback: '#8FA6BF',
      radius: ['interpolate', ['linear'], ['zoom'],
        0, 0.45, 3, 0.7, 6, 1.2, 10, 2.2, 14, 4, 18, 7],
      glowScale: 3.2,
      glowOpacity: ['interpolate', ['linear'], ['zoom'], 0, 0.5, 6, 0.36, 14, 0.26],
      coreOpacity: ['interpolate', ['linear'], ['zoom'], 0, 0.85, 6, 0.95],
      coreTint: 0.45,
    });

    for(const layer of layers) map.addLayer(layer);
  },

  filters(){
    const counts = BRANDS.map(() => 0);
    for(const r of rows) counts[r[2]]++;
    return [{
      title: 'Manufacturer',
      items: BRANDS.map((b, i) => ({
        key: String(i),
        label: b.label,
        colour: b.hex,
        count: counts[i],
        on: active.has(i),
      })),
    }];
  },

  toggleFilter(key, on){
    const i = +key;
    if(on) active.add(i); else active.delete(i);
  },

  applyFilter(map, visible){
    if(!map.getLayer('cam-core')) return;
    // A `match` needs at least one label, so an all-off state is spelled out
    // as an expression that matches nothing.
    const filter = active.size
      ? ['match', ['get','b'], [...active], true, false]
      : ['==', ['literal', 1], ['literal', 0]];

    for(const id of ['cam-glow', 'cam-core']){
      map.setFilter(id, filter);
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  },

  popup(f){
    const r = rows[f.properties.i];
    const b = BRANDS[r[2]] || BRANDS[4];

    const items = [
      ['Type',     pick('type',  r[7])],
      ['Make',     pick('mfr',   r[3])],
      ['Operator', pick('op',    r[4])],
      ['Facing',   r[5] >= 0 ? r[5] + '°' : null],
      ['Mount',    pick('mount', r[6])],
    ].filter(x => x[1]);

    const osm = (r[8] === 0 ? 'node/' : 'way/') + r[9];
    return `<div class="pop">
      <p class="pop-title"><span class="dot" style="color:${b.hex}"></span>${esc(b.label)}</p>
      <dl>${items.map(x => `<dt>${esc(x[0])}</dt><dd>${esc(x[1])}</dd>`).join('')}</dl>
      <a href="https://www.openstreetmap.org/${osm}" target="_blank" rel="noopener">View on OpenStreetMap</a>
    </div>`;
  },

  summary(){
    return `${num(rows.length)} cameras`;
  },

  legend(){
    return {
      note: `Crowdsourced, so a dark area means nobody has mapped it —
             not that it has no cameras. Data ${generated.slice(0, 10)}.`,
      source: 'OpenStreetMap',
      url: 'https://www.openstreetmap.org/copyright',
    };
  },
};
