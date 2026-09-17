/*
   ALPR camera layer.

   Every camera ships as a static file built by scripts/harvest.py, so the page
   makes no data API calls for it at runtime.  That is deliberate: the public
   Overpass instances explicitly forbid being queried from a browser on every
   map move, and would rate-limit visitors of an app that did.
*/

import { esc, num, fetchJSON } from './util.js';

const DATA_URL = 'data/cameras.json';

const BRANDS = [
  { key:'flock',    label:'Flock Safety',        hex:'#E0873B' },
  { key:'motorola', label:'Motorola / Vigilant', hex:'#4A6FA5' },
  { key:'genetec',  label:'Genetec',             hex:'#5C8C6A' },
  { key:'elsag',    label:'Leonardo / ELSAG',    hex:'#8E6BA8' },
  { key:'other',    label:'Other / unlabelled',  hex:'#7C8794' },
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
  colour: '#E0873B',
  defaultOn: true,
  interactive: ['cam', 'cam-clusters'],

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
      cluster: true,
      clusterRadius: 46,
      clusterMaxZoom: 15,
    });

    map.addLayer({
      id: 'cam-clusters', type: 'circle', source: 'cams',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': '#141A22',
        'circle-opacity': .92,
        'circle-stroke-width': 4,
        'circle-stroke-color': 'rgba(20,26,34,.16)',
        'circle-radius': ['step', ['get','point_count'], 15, 20, 19, 100, 24, 1000, 30],
      },
    });

    map.addLayer({
      id: 'cam-cluster-count', type: 'symbol', source: 'cams',
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-font': ['Noto Sans Bold'],
        'text-size': 12,
        'text-allow-overlap': true,
      },
      paint: { 'text-color': '#fff' },
    });

    const brandColour = ['match', ['get','b']];
    BRANDS.forEach((b, i) => brandColour.push(i, b.hex));
    brandColour.push('#7C8794');

    map.addLayer({
      id: 'cam', type: 'circle', source: 'cams',
      filter: ['!', ['has','point_count']],
      paint: {
        'circle-color': brandColour,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3.5, 14, 6, 18, 9],
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#fff',
        'circle-opacity': .95,
      },
    });
  },

  layerIds: ['cam-clusters', 'cam-cluster-count', 'cam'],

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

  applyFilter(map){
    const src = map.getSource('cams');
    if(!src) return;
    // Re-set the source rather than setFilter, so cluster counts reflect the
    // visible brands instead of silently counting hidden points.
    const features = active.size === BRANDS.length
      ? allFeatures
      : allFeatures.filter(f => active.has(f.properties.b));
    src.setData({ type:'FeatureCollection', features });
  },

  popup(f){
    if(f.properties.point_count) return null;      // a cluster; caller zooms
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
      <p class="pop-title"><span class="dot" style="background:${b.hex}"></span>${esc(b.label)}</p>
      <dl>${items.map(x => `<dt>${esc(x[0])}</dt><dd>${esc(x[1])}</dd>`).join('')}</dl>
      <a href="https://www.openstreetmap.org/${osm}" target="_blank" rel="noopener">View on OpenStreetMap</a>
    </div>`;
  },

  summary(){
    return `${num(rows.length)} cameras`;
  },

  legend(){
    return {
      note: `Crowdsourced, so a blank area means nobody has mapped it —
             not that it has no cameras. Data ${generated.slice(0, 10)}.`,
      source: 'OpenStreetMap',
      url: 'https://www.openstreetmap.org/copyright',
    };
  },
};
