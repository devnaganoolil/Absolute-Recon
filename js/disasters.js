/*
   Natural disaster layer, merged from USGS, NASA EONET and GDACS by
   scripts/harvest_disasters.py.

   All three feeds are keyless and CORS-open, so this could refresh live in the
   browser.  It deliberately does not: normalising three different schemas into
   one is the bulk of the harvester, and doing it again in JavaScript would mean
   two implementations of the same category mapping, free to drift apart.  The
   Action re-runs every three hours instead, which is fresh enough for a map
   whose shortest-lived hazard is a wildfire.

   These used to be drawn as icons -- a coloured disc with a white glyph per
   hazard.  On a night globe they read as stickers pasted over the planet, so
   they are lights now like everything else.  What keeps them apart from the
   conflict layer, which is also warm-coloured light, is the ring: anything
   GDACS or USGS graded orange or red gets a bright circle around it, and
   nothing on any other layer has one.
*/

import { esc, num, when, dateLabel, fetchJSON } from './util.js';
import { lightLayers } from './lights.js';

const DATA_URL = 'data/disasters.json';

// Hazard hues, neon enough to hold against black.
const KINDS = [
  { key:'quake',    label:'Earthquakes', hex:'#9B8CFF' },
  { key:'storm',    label:'Storms',      hex:'#37E2CE' },
  { key:'flood',    label:'Floods',      hex:'#4FB0FF' },
  { key:'wildfire', label:'Wildfires',   hex:'#FF7A1A' },
  { key:'volcano',  label:'Volcanoes',   hex:'#FF5233' },
  { key:'drought',  label:'Drought',     hex:'#F2C94C' },
  { key:'other',    label:'Other',       hex:'#9FB0C4' },
];

// GDACS and USGS both grade severity this way. Only the top two are worth
// ringing on the map.
const ALERT_RING = { red:'#FF3B3B', orange:'#FFA23B' };

let payload = null;
let features = [];

const activeKinds = new Set(KINDS.map(k => k.key));
let severeOnly = false;

const kindOf = key => KINDS.find(k => k.key === key) || KINDS[KINDS.length - 1];

export default {
  id: 'disasters',
  label: 'Natural disasters',
  blurb: 'Quakes, fires, storms and floods — USGS, NASA and GDACS',
  colour: '#37E2CE',
  defaultOn: true,
  interactive: ['disaster-core'],
  layerIds: ['disaster-glow', 'disaster-core'],

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

  addLayers(map){
    map.addSource('disasters', {
      type: 'geojson',
      data: { type:'FeatureCollection', features },
    });

    const radius = ['interpolate', ['linear'], ['zoom'],
      1,  ['interpolate', ['linear'], ['get','w'], 0, 1.6, 1, 4.5],
      6,  ['interpolate', ['linear'], ['get','w'], 0, 2.8, 1, 8],
      12, ['interpolate', ['linear'], ['get','w'], 0, 4.5, 1, 13],
    ];

    for(const layer of lightLayers({
      idPrefix: 'disaster',
      source: 'disasters',
      property: 'kind',
      stops: KINDS.map(k => [k.key, k.hex]),
      fallback: '#9FB0C4',
      radius,
      glowScale: 3.2,
      glowOpacity: 0.4,
      coreOpacity: 0.92,
      coreTint: 0.5,
      stroke: {
        colour: ['match', ['get','alert'],
          'red', ALERT_RING.red, 'orange', ALERT_RING.orange, 'transparent'],
        width: ['case', ['==', ['get','severe'], 1], 1.4, 0],
        opacity: 0.9,
      },
    })) map.addLayer(layer);
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
    if(!map.getLayer('disaster-core')) return;

    // A `match` with an empty label list is not a valid expression, so an
    // all-off state has to be spelled out as "match nothing".
    const clauses = [activeKinds.size
      ? ['match', ['get','kind'], [...activeKinds], true, false]
      : ['==', ['literal', 1], ['literal', 0]]];
    if(severeOnly) clauses.push(['==', ['get','severe'], 1]);

    const filter = ['all', ...clauses];
    const vis = visible ? 'visible' : 'none';
    for(const id of ['disaster-glow', 'disaster-core']){
      map.setFilter(id, filter);
      map.setLayoutProperty(id, 'visibility', vis);
    }
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
      <p class="pop-title"><span class="dot" style="color:${k.hex}"></span>${esc(e.title)}</p>
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
