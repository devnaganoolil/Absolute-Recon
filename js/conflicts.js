/*
   Armed conflict layer, from UCDP's Georeferenced Event Dataset.

   Two views of the same data, because they answer different questions:

     conflict bubbles -- one per conflict, sized by the death toll in the
                         window. This is the "which wars are running" view, and
                         it is what you want at world zoom.
     event dots       -- the individual reported incidents. Only worth drawing
                         once you have zoomed into a region, so they carry a
                         minzoom.

   Both are built by scripts/harvest_conflicts.py. The conflict list is derived
   from the events rather than curated, which keeps it self-updating but means
   a territorial dispute with no recent casualties is simply absent.
*/

import { esc, num, dateLabel, fetchJSON } from './util.js';
import { lightLayers } from './lights.js';

const DATA_URL = 'data/conflicts.json';

// UCDP's three kinds of organised violence.
const VIOLENCE = [
  { tov:1, key:'state',    label:'State-based',  hex:'#FF3B4E',
    hint:'A government is one of the parties' },
  { tov:2, key:'nonstate', label:'Non-state',    hex:'#FF9A3C',
    hint:'Neither party is a government' },
  { tov:3, key:'onesided', label:'Against civilians', hex:'#FF4FD8',
    hint:'Organised violence against unarmed civilians' },
];

const RANGES = [
  { key:'30',   label:'30 days',  days:30 },
  { key:'90',   label:'90 days',  days:90 },
  { key:'365',  label:'12 months',days:365 },
  { key:'all',  label:'Full window', days:null },
];

// Don't label every one of ~900 conflicts; below this the light is a dot and
// the name would be noise. A globe at world zoom has more empty sea to put
// labels in than a flat map did, so collision alone left it looking like a
// list -- the threshold does the thinning and the sort key handles the rest.
const LABEL_MIN_DEATHS = 400;

let payload = null;
let events = [];         // GeoJSON features, one per reported event
let conflicts = [];      // GeoJSON features, one per conflict
let latestDay = 0;       // most recent event in the file, as an epoch day

const activeTov = new Set(VIOLENCE.map(v => v.tov));
const showing = { bubbles:true, events:true };
let range = '365';

const pick = (pool, idx) =>
  (idx >= 0 && payload?.pools?.[pool] ? payload.pools[pool][idx] : null);

/**
 * Day number for the start of the chosen range, or null for "everything".
 *
 * Measured back from the newest event in the file, not from today. UCDP's
 * candidate releases lag real time by roughly two months, so counting back
 * from today made "last 30 days" return nothing at all -- which reads as "no
 * political violence last month" rather than "not coded yet".
 */
function minDay(){
  const r = RANGES.find(x => x.key === range);
  return !r || r.days === null ? null : latestDay - r.days;
}

const dayISO = day => new Date(day * 86400000).toISOString().slice(0, 10);

export default {
  id: 'conflicts',
  label: 'Armed conflict',
  blurb: 'Reported political violence, from UCDP',
  colour: '#FF3B4E',
  // 1.8 MB gzipped, and not what most visitors came for, so it is fetched the
  // first time somebody switches it on rather than at boot.
  defaultOn: false,
  interactive: ['conflict-bubble-core', 'conflict-event-core'],
  layerIds: [
    'conflict-event-glow', 'conflict-event-core',
    'conflict-bubble-glow', 'conflict-bubble-core', 'conflict-label',
  ],

  async load(onProgress){
    payload = await fetchJSON(DATA_URL, onProgress);

    conflicts = payload.conflicts.map((c, i) => ({
      type: 'Feature',
      geometry: { type:'Point', coordinates:[c.lon, c.lat] },
      properties: {
        i,
        tov: c.tov,
        deaths: c.deaths,
        events: c.events,
        name: c.name,
        // Pre-resolved so the label layer can filter on it without an
        // expression that re-reads the conflict list.
        labelled: c.deaths >= LABEL_MIN_DEATHS ? 1 : 0,
      },
    }));

    latestDay = payload.rows.reduce((max, r) => r[2] > max ? r[2] : max, 0);

    events = payload.rows.map((r, i) => ({
      type: 'Feature',
      geometry: { type:'Point', coordinates:[r[1], r[0]] },
      properties: {
        i,
        day: r[2],
        tov: r[3],
        c: r[4],
        deaths: r[7],
        // where_prec 4+ means UCDP only knows the province or the country, so
        // the dot is drawn hollow instead of implying a street corner.
        vague: r[9] >= 4 ? 1 : 0,
      },
    }));

    return {
      count: events.length,
      conflicts: payload.conflicts.length,
      generated: payload.generated,
    };
  },

  addLayers(map){
    const stops = VIOLENCE.map(v => [v.tov, v.hex]);

    map.addSource('conflict-events', {
      type: 'geojson',
      data: { type:'FeatureCollection', features: events },
    });
    map.addSource('conflict-list', {
      type: 'geojson',
      data: { type:'FeatureCollection', features: conflicts },
    });

    // Individual events. sqrt so a 1,000-death event is ~30x a 1-death one in
    // area, not 1000x, and a floor so a zero-casualty event still shows.
    const eventRadius = ['interpolate', ['linear'], ['zoom'],
      4,  ['interpolate', ['linear'], ['sqrt', ['get','deaths']], 0, 1.1, 40, 6],
      10, ['interpolate', ['linear'], ['sqrt', ['get','deaths']], 0, 2.4, 40, 15],
      16, ['interpolate', ['linear'], ['sqrt', ['get','deaths']], 0, 4,   40, 26],
    ];

    for(const layer of lightLayers({
      idPrefix: 'conflict-event',
      source: 'conflict-events',
      property: 'tov',
      stops,
      fallback: '#FF8FA0',
      radius: eventRadius,
      glowScale: 3,
      // Events UCDP could only place at province level or coarser are dimmed
      // rather than hidden: still visible as a haze over the right region,
      // without a hard dot implying a street corner.
      glowOpacity: ['case', ['==', ['get','vague'], 1], 0.14, 0.34],
      coreOpacity: ['case', ['==', ['get','vague'], 1], 0.22, 0.8],
      coreTint: 0.4,
      minzoom: 4,
    })) map.addLayer(layer);

    // One light per conflict, brighter and much larger than any single event.
    const bubbleRadius = ['interpolate', ['linear'], ['zoom'],
      0, ['interpolate', ['linear'], ['sqrt', ['get','deaths']], 0, 1.8, 400, 15],
      6, ['interpolate', ['linear'], ['sqrt', ['get','deaths']], 0, 3,   400, 27],
    ];

    for(const layer of lightLayers({
      idPrefix: 'conflict-bubble',
      source: 'conflict-list',
      property: 'tov',
      stops,
      fallback: '#FF8FA0',
      radius: bubbleRadius,
      glowScale: 3.4,
      glowOpacity: 0.42,
      coreOpacity: 0.9,
      coreTint: 0.55,
    })) map.addLayer(layer);

    map.addLayer({
      id: 'conflict-label', type: 'symbol', source: 'conflict-list',
      filter: ['==', ['get','labelled'], 1],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Bold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 6, 13],
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-max-width': 11,
        'text-padding': 4,
        // At world zoom far more labels qualify than can fit. Sorting by death
        // toll descending means MapLibre's collision pass drops the smallest
        // conflicts first, so the names you do get are the ones that matter --
        // and more of them appear as you zoom in, without a zoom-stepped
        // filter (which MapLibre does not allow on `filter`).
        'symbol-sort-key': ['-', 0, ['get', 'deaths']],
      },
      paint: {
        'text-color': '#FFD6DC',
        'text-halo-color': 'rgba(4, 8, 20, 0.9)',
        'text-halo-width': 1.6,
      },
    });
  },

  filters(){
    const counts = new Map(VIOLENCE.map(v => [v.tov, 0]));
    const floor = minDay();
    for(const f of events){
      if(floor === null || f.properties.day >= floor){
        counts.set(f.properties.tov, (counts.get(f.properties.tov) || 0) + 1);
      }
    }

    return [
      {
        title: 'Show',
        items: [
          { key:'show:bubbles', label:'Conflicts', colour:'#A31621',
            count: conflicts.length, on: showing.bubbles },
          { key:'show:events', label:'Individual events', colour:'#C75146',
            count: events.length, on: showing.events, note:'from zoom 4' },
        ],
      },
      {
        title: 'Type of violence',
        items: VIOLENCE.map(v => ({
          key: 'tov:' + v.tov,
          label: v.label,
          colour: v.hex,
          count: counts.get(v.tov) || 0,
          title: v.hint,
          on: activeTov.has(v.tov),
        })),
      },
    ];
  },

  range: {
    title: 'Events in the most recent',
    options: RANGES.map(r => ({ key:r.key, label:r.label })),
    get value(){ return range; },
  },

  setRange(key){ range = key; },

  toggleFilter(key, on){
    const [kind, value] = key.split(':');
    if(kind === 'show'){
      showing[value] = on;
    }else{
      const tov = +value;
      if(on) activeTov.add(tov); else activeTov.delete(tov);
    }
  },

  applyFilter(map, visible){
    if(!map.getLayer('conflict-event-core')) return;

    // As above: an empty label list is not a valid `match`.
    const tovFilter = activeTov.size
      ? ['match', ['get','tov'], [...activeTov], true, false]
      : ['==', ['literal', 1], ['literal', 0]];
    const floor = minDay();
    // No day clause at all for the full window. An unbounded floor used to be
    // -Infinity, which JSON-serialises to null inside a MapLibre expression,
    // and `>= null` quietly matches nothing rather than everything.
    const eventFilter = floor === null
      ? ['all', tovFilter]
      : ['all', tovFilter, ['>=', ['get','day'], floor]];

    for(const id of ['conflict-event-glow', 'conflict-event-core']){
      map.setFilter(id, eventFilter);
    }
    for(const id of ['conflict-bubble-glow', 'conflict-bubble-core']){
      map.setFilter(id, tovFilter);
    }
    map.setFilter('conflict-label', ['all', tovFilter, ['==', ['get','labelled'], 1]]);

    const vis = on => on && visible ? 'visible' : 'none';
    for(const id of ['conflict-event-glow', 'conflict-event-core']){
      map.setLayoutProperty(id, 'visibility', vis(showing.events));
    }
    for(const id of ['conflict-bubble-glow', 'conflict-bubble-core', 'conflict-label']){
      map.setLayoutProperty(id, 'visibility', vis(showing.bubbles));
    }
  },

  popup(f){
    return f.layer.id === 'conflict-bubble-core'
      ? conflictPopup(payload.conflicts[f.properties.i])
      : eventPopup(payload.rows[f.properties.i]);
  },

  summary(){
    return `${num(payload.conflicts.length)} conflicts, ${num(events.length)} events`;
  },

  legend(){
    // The lag is the single most confusing thing about this layer, so it is
    // stated rather than left for someone to infer from an empty map.
    return {
      note: `${payload.windowStart} to ${dayISO(latestDay)}. UCDP codes events
             from news reporting, so the last month or two is not in yet.
             Deaths are UCDP's "best" estimate.`,
      source: 'UCDP',
      url: 'https://ucdp.uu.se/',
    };
  },
};

function violenceOf(tov){
  return VIOLENCE.find(v => v.tov === tov) || VIOLENCE[0];
}

function conflictPopup(c){
  const v = violenceOf(c.tov);
  const rows = [
    ['Parties', [c.sideA, c.sideB].filter(Boolean).join(' vs ')],
    ['Where', c.countries.join(', ')],
    ['Deaths', num(c.deaths) + (c.civilians ? ` (${num(c.civilians)} civilian)` : '')],
    ['Events', num(c.events)],
    ['Reported', `${c.first} to ${c.last}`],
  ].filter(x => x[1]);

  return `<div class="pop">
    <p class="pop-title"><span class="dot" style="color:${v.hex}"></span>${esc(c.name)}</p>
    <p class="pop-tag">${esc(v.label)} conflict</p>
    <dl>${rows.map(x => `<dt>${esc(x[0])}</dt><dd>${esc(x[1])}</dd>`).join('')}</dl>
    <a href="https://ucdp.uu.se/conflict/${encodeURIComponent(c.id)}"
       target="_blank" rel="noopener">UCDP conflict profile</a>
  </div>`;
}

function eventPopup(r){
  const v = violenceOf(r[3]);
  const c = payload.conflicts[r[4]];
  const date = dayISO(r[2]);
  // Harvested headlines arrive as a ';'-joined list of every source article.
  const headline = (pick('headline', r[10]) || '').split(';')[0].trim();

  const place = [pick('adm1', r[6]), pick('country', r[5])].filter(Boolean).join(', ');
  const rows = [
    ['Date', dateLabel(date)],
    ['Where', place],
    ['Deaths', num(r[7]) + (r[8] ? ` (${num(r[8])} civilian)` : '')],
    ['Conflict', c ? c.name : null],
  ].filter(x => x[1]);

  // where_prec: 1 exact, 2 near, 3 within ~25km, 4 the province, 5 a larger
  // region, 6 the country, 7 unknown. Anything past 3 is worth saying out loud.
  const vague = r[9] >= 4 ? `<p class="pop-warn">Location is approximate —
    UCDP placed this at ${r[9] >= 6 ? 'country' : 'province'} level.</p>` : '';

  return `<div class="pop">
    <p class="pop-title"><span class="dot" style="color:${v.hex}"></span>${esc(v.label)} violence</p>
    ${headline ? `<p class="pop-lede">${esc(headline)}</p>` : ''}
    <dl>${rows.map(x => `<dt>${esc(x[0])}</dt><dd>${esc(x[1])}</dd>`).join('')}</dl>
    ${vague}
    <a href="https://ucdp.uu.se/" target="_blank" rel="noopener">About UCDP data</a>
  </div>`;
}
