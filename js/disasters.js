/*
   Natural disaster layer, merged from USGS, NASA EONET and GDACS by
   scripts/harvest_disasters.py.

   All three feeds are keyless and CORS-open, so this could refresh live in the
   browser.  It deliberately does not: normalising three different schemas into
   one is the bulk of the harvester, and doing it again in JavaScript would mean
   two implementations of the same category mapping, free to drift apart.  The
   Action re-runs every three hours instead, which is fresh enough for a map
   whose shortest-lived hazard is a wildfire.

   Disasters are drawn as icons rather than circles.  Cameras are dots and
   conflict is red circles, so shape -- not colour -- is what tells the three
   layers apart when they overlap.
*/

import { esc, num, when, dateLabel, fetchJSON } from './util.js';

const DATA_URL = 'data/disasters.json';

const KINDS = [
  { key:'quake',    label:'Earthquakes', hex:'#5B5F97' },
  { key:'storm',    label:'Storms',      hex:'#2A9D8F' },
  { key:'flood',    label:'Floods',      hex:'#2E6F9E' },
  { key:'wildfire', label:'Wildfires',   hex:'#E2711D' },
  { key:'volcano',  label:'Volcanoes',   hex:'#8C4A2F' },
  { key:'drought',  label:'Drought',     hex:'#B8923A' },
  { key:'other',    label:'Other',       hex:'#6B7280' },
];

// GDACS and USGS both grade severity this way. Only the top two are worth
// ringing on the map.
const ALERT_RING = { red:'#C1121F', orange:'#E07A1F' };

let payload = null;
let features = [];

const activeKinds = new Set(KINDS.map(k => k.key));
let severeOnly = false;

const kindOf = key => KINDS.find(k => k.key === key) || KINDS[KINDS.length - 1];

/* ---------- icons ----------
   One 40x40 sprite per kind: a filled disc in the kind's colour with a white
   glyph on it. A disc keeps every icon legible against whatever the basemap is
   doing underneath, which a bare glyph is not.                              */

const GLYPHS = {
  // Seismograph trace.
  quake: '<path d="M6 20h4l3-8 4 16 4-12 3 4h6" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  // Cyclone spiral.
  storm: '<path d="M20 20c0-4 4-6 7-4 4 2 4 8-1 10-6 2-13-2-13-9" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><circle cx="20" cy="20" r="2.4" fill="#fff"/>',
  // Water.
  flood: '<path d="M7 16c3-3 6-3 9 0s6 3 9 0 6-3 8-1" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><path d="M7 24c3-3 6-3 9 0s6 3 9 0 6-3 8-1" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>',
  // Flame.
  wildfire: '<path d="M20 7c5 6 9 8 9 14a9 9 0 0 1-18 0c0-4 3-6 4-9 1 3 3 4 4 2 1-2-1-4 1-7z" fill="#fff"/>',
  // Cone with a plume.
  volcano: '<path d="M11 30l6-11h6l6 11z" fill="#fff"/><path d="M20 16V9M20 9l-4-3M20 9l4-3" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>',
  // Sun over cracked ground.
  drought: '<circle cx="20" cy="15" r="5" fill="#fff"/><path d="M20 5v3M20 22v3M10 15h3M27 15h3M13 8l2 2M27 8l-2 2" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><path d="M8 28h24" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>',
  other: '<circle cx="20" cy="20" r="6" fill="#fff"/>',
};

function svgFor(kind){
  return `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
    <circle cx="20" cy="20" r="18" fill="${kind.hex}" stroke="#fff" stroke-width="2.5"/>
    ${GLYPHS[kind.key] || GLYPHS.other}
  </svg>`;
}

/** Rasterise one SVG string and hand MapLibre the pixels. */
function addIcon(map, name, svg){
  return new Promise(resolve => {
    const img = new Image(40, 40);
    // Explicitly not a blob URL: those need revoking, and a data URI of this
    // size decodes just as fast.
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    img.onload = () => {
      if(!map.hasImage(name)) map.addImage(name, img, { pixelRatio: 2 });
      resolve();
    };
    // An icon that fails to decode must not wedge the boot sequence; the
    // symbol layer just falls back to the 'other' sprite.
    img.onerror = () => resolve();
  });
}

export default {
  id: 'disasters',
  label: 'Natural disasters',
  blurb: 'Quakes, fires, storms and floods — USGS, NASA and GDACS',
  // Teal, not the wildfire orange: the panel switch sits right under the
  // camera layer's orange one and the two were indistinguishable.
  colour: '#2A9D8F',
  defaultOn: true,
  interactive: ['disaster-icon'],
  layerIds: ['disaster-alert', 'disaster-icon'],

  async load(onProgress){
    payload = await fetchJSON(DATA_URL, onProgress);

    features = payload.events.map((e, i) => ({
      type: 'Feature',
      geometry: { type:'Point', coordinates:[e.lon, e.lat] },
      properties: {
        i,
        kind: e.kind,
        // A 0-1 significance score the harvester normalises per hazard type;
        // `mag` itself is not comparable across sources (Richter vs km/h vs
        // km2), so it is only ever shown as text in the popup.
        w: e.weight ?? 0.4,
        alert: e.alert || '',
        severe: (e.alert === 'red' || e.alert === 'orange') ? 1 : 0,
      },
    }));

    return { count: features.length, generated: payload.generated };
  },

  async prepare(map){
    await Promise.all(KINDS.map(k => addIcon(map, 'hz-' + k.key, svgFor(k))));
  },

  addLayers(map){
    map.addSource('disasters', {
      type: 'geojson',
      data: { type:'FeatureCollection', features },
    });

    // Halo behind the icon for anything GDACS or USGS flagged orange or red.
    map.addLayer({
      id: 'disaster-alert', type: 'circle', source: 'disasters',
      filter: ['==', ['get','severe'], 1],
      paint: {
        'circle-color': [
          'match', ['get','alert'],
          'red', ALERT_RING.red,
          'orange', ALERT_RING.orange,
          'transparent',
        ],
        'circle-opacity': 0.28,
        'circle-stroke-width': 1.5,
        'circle-stroke-opacity': 0.75,
        'circle-stroke-color': [
          'match', ['get','alert'],
          'red', ALERT_RING.red,
          'orange', ALERT_RING.orange,
          'transparent',
        ],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 13, 8, 26],
      },
    });

    map.addLayer({
      id: 'disaster-icon', type: 'symbol', source: 'disasters',
      layout: {
        'icon-image': ['concat', 'hz-', ['get','kind']],
        // Bigger for a more significant event, and bigger as you zoom in.
        'icon-size': [
          'interpolate', ['linear'], ['zoom'],
          1,  ['interpolate', ['linear'], ['get','w'], 0, 0.28, 1, 0.55],
          6,  ['interpolate', ['linear'], ['get','w'], 0, 0.40, 1, 0.78],
          12, ['interpolate', ['linear'], ['get','w'], 0, 0.58, 1, 1.05],
        ],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });
  },

  filters(){
    const counts = new Map(KINDS.map(k => [k.key, 0]));
    for(const f of features){
      if(severeOnly && !f.properties.severe) continue;
      counts.set(f.properties.kind, (counts.get(f.properties.kind) || 0) + 1);
    }

    return [
      {
        title: 'Hazard',
        items: KINDS.map(k => ({
          key: 'kind:' + k.key,
          label: k.label,
          colour: k.hex,
          count: counts.get(k.key) || 0,
          on: activeKinds.has(k.key),
        })).filter(item => item.count > 0 || activeKinds.has(item.key.slice(5))),
      },
      {
        title: 'Severity',
        items: [
          { key:'severe', label:'Orange & red alerts only', colour:ALERT_RING.red,
            count: features.filter(f => f.properties.severe).length,
            on: severeOnly,
            title:'Events GDACS or USGS graded as significant humanitarian impact' },
        ],
      },
    ];
  },

  toggleFilter(key, on){
    if(key === 'severe'){ severeOnly = on; return; }
    const kind = key.slice(5);
    if(on) activeKinds.add(kind); else activeKinds.delete(kind);
  },

  applyFilter(map, visible){
    if(!map.getLayer('disaster-icon')) return;

    // A `match` with an empty label list is not a valid expression, so an
    // all-off state has to be spelled out as "match nothing".
    const clauses = [activeKinds.size
      ? ['match', ['get','kind'], [...activeKinds], true, false]
      : ['==', ['literal', 1], ['literal', 0]]];
    if(severeOnly) clauses.push(['==', ['get','severe'], 1]);

    map.setFilter('disaster-icon', ['all', ...clauses]);
    map.setFilter('disaster-alert', ['all', ['==', ['get','severe'], 1], ...clauses]);

    const vis = visible ? 'visible' : 'none';
    map.setLayoutProperty('disaster-icon', 'visibility', vis);
    map.setLayoutProperty('disaster-alert', 'visibility', vis);
  },

  popup(f){
    const e = payload.events[f.properties.i];
    const k = kindOf(e.kind);

    const magnitude = e.mag != null && e.mag !== 0
      ? (e.kind === 'quake' ? `M ${e.mag}` : `${e.mag}${e.magUnit ? ' ' + e.magUnit : ''}`)
      : null;

    const rows = [
      ['When', dateLabel(e.date)],
      ['Where', e.place],
      [e.kind === 'quake' ? 'Magnitude' : 'Severity', magnitude || e.severityText],
      ['Depth', e.depthKm != null ? `${e.depthKm} km` : null],
      ['Alert', e.alert ? e.alert[0].toUpperCase() + e.alert.slice(1) : null],
      ['Started', e.started && e.started !== e.date ? e.started : null],
      ['Track', e.track > 1 ? `${num(e.track)} observations` : null],
      ['Source', e.src],
    ].filter(x => x[1]);

    // Volcanoes and droughts are kept past the normal window because their
    // sources treat them as one long-running event, so say when it was seen.
    const ago = when(e.date);
    const stale = (e.kind === 'volcano' || e.kind === 'drought') && e.date
      ? `<p class="pop-warn">Long-running event, kept while its source still
           lists it as active — last updated ${ago || 'over a year ago'}.</p>`
      : '';

    return `<div class="pop">
      <p class="pop-title"><span class="dot" style="background:${k.hex}"></span>${esc(e.title)}</p>
      <p class="pop-tag">${esc(k.label)}</p>
      <dl>${rows.map(x => `<dt>${esc(x[0])}</dt><dd>${esc(x[1])}</dd>`).join('')}</dl>
      ${stale}
      ${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">Full report</a>` : ''}
    </div>`;
  },

  summary(){
    return `${num(features.length)} events`;
  },

  legend(){
    return {
      note: `Last ${payload.windowDays} days. Earthquakes M4.0+ only.`,
      source: 'USGS · NASA EONET · GDACS',
      url: 'https://www.gdacs.org/',
    };
  },
};
