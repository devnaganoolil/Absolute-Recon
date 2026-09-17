/*
   The globe itself: style, atmosphere, starfield and idle rotation.

   MapLibre grew a real globe projection in v5, so this is a projection on the
   map rather than a separate 3D engine -- every existing layer, filter and
   popup keeps working, it just wraps onto a sphere.

   The style is hand-written instead of pulling one of OpenFreeMap's, because
   none of theirs is dark enough. It draws only what a night-side Earth needs:
   near-black land, darker water, a faint lit coastline, country borders and a
   graticule. Everything else on screen is supposed to be the data.
*/

// OpenFreeMap's planet tiles, OpenMapTiles schema. Keyless and unmetered.
const TILES = 'https://tiles.openfreemap.org/planet';

export const SPACE = '#04060E';

const INK = {
  land:      '#0B1222',
  water:     '#05080E',
  coast:     'rgba(64, 224, 255, 0.20)',
  border:    'rgba(64, 224, 255, 0.34)',
  subborder: 'rgba(64, 224, 255, 0.13)',
  grid:      'rgba(64, 224, 255, 0.16)',
  label:     'rgba(173, 216, 240, 0.72)',
  labelHalo: 'rgba(4, 8, 20, 0.85)',
};

/**
 * The zoom at which the globe just fits the viewport.
 *
 * MapLibre sizes the sphere from the zoom alone, so a fixed starting zoom
 * gives a planet that fills a laptop and overflows a phone. The world is
 * 512 * 2^zoom pixels around, so its diameter is that over pi; solve for the
 * zoom that puts the diameter at `fill` of the smaller viewport axis.
 */
export function fitZoom(fill = 0.82){
  const span = Math.min(window.innerWidth, window.innerHeight);
  const zoom = Math.log2((fill * span * Math.PI) / 512);
  return Math.max(0.6, Math.min(3, zoom));
}

export function buildStyle(){
  return {
    version: 8,
    projection: { type: 'globe' },
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      ofm: {
        type: 'vector',
        url: TILES,
        attribution:
          '<a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a> ' +
          '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      },
      graticule: { type: 'geojson', data: graticule() },
    },
    layers: [
      // Land is the background; the OpenMapTiles schema has no land polygon,
      // it draws water on top of one.
      { id: 'land', type: 'background', paint: { 'background-color': INK.land } },

      { id: 'water', type: 'fill', source: 'ofm', 'source-layer': 'water',
        paint: { 'fill-color': INK.water } },

      // The outline of the water polygons is the coastline, and a faint lit
      // edge there is what makes the continents read at a glance.
      { id: 'coast', type: 'line', source: 'ofm', 'source-layer': 'water',
        paint: {
          'line-color': INK.coast,
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.5, 4, 0.8, 10, 1.4],
        } },

      { id: 'graticule', type: 'line', source: 'graticule',
        paint: {
          'line-color': INK.grid,
          'line-width': 0.5,
          // The grid sells the hologram at a distance and is clutter up close.
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 0, 1, 4, 0.5, 6, 0],
        } },

      { id: 'border-sub', type: 'line', source: 'ofm', 'source-layer': 'boundary',
        filter: ['all', ['>', ['get', 'admin_level'], 2], ['<=', ['get', 'admin_level'], 4]],
        minzoom: 3,
        paint: { 'line-color': INK.subborder, 'line-width': 0.6 } },

      { id: 'border', type: 'line', source: 'ofm', 'source-layer': 'boundary',
        filter: ['<=', ['get', 'admin_level'], 2],
        paint: {
          'line-color': INK.border,
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.5, 4, 0.9, 10, 1.6],
        } },

      // Labels are split by class rather than filtered by rank, because
      // MapLibre does not allow `zoom` inside a layer filter and one combined
      // layer buried the planet in Siberian village names at orbit distance.
      // The data is the thing to look at; place names are here to orient, so
      // each class waits until the zoom where it starts being useful.
      placeLayer('place-country', 'country', 1.2, [1.2, 10, 4, 13, 8, 15], 0.78),
      placeLayer('place-city', 'city', 4.5, [4.5, 11, 9, 13, 14, 15], 0.62),
    ],
  };
}

/** One class of place name, appearing at the zoom where it earns its space. */
function placeLayer(id, cls, minzoom, sizeStops, opacity){
  return {
    id, type: 'symbol', source: 'ofm', 'source-layer': 'place',
    filter: ['==', ['get', 'class'], cls],
    minzoom,
    layout: {
      'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], ...sizeStops],
      'text-max-width': 8,
      'text-padding': 6,
      // OpenMapTiles ranks places by importance; let collision drop the
      // obscure ones first when the screen gets crowded.
      'symbol-sort-key': ['coalesce', ['get', 'rank'], 100],
    },
    paint: {
      'text-color': INK.label,
      'text-opacity': opacity,
      'text-halo-color': INK.labelHalo,
      'text-halo-width': 1.4,
    },
  };
}

/** The blue limb around the planet, fading out as you drop towards the ground. */
export function applySky(map){
  map.setSky({
    'sky-color': '#0A1A33',
    'horizon-color': '#1E5C9E',
    'fog-color': '#050A16',
    'sky-horizon-blend': 0.7,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.1,
    // Full atmosphere in orbit, none once you are looking at streets.
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 0.6, 8, 0],
  });
}

/* ---------- graticule ---------- */

/**
 * Meridians and parallels as GeoJSON.
 *
 * Densified rather than drawn corner to corner: the globe projection curves a
 * line between its vertices only as far as those vertices allow, so a meridian
 * with two points renders as a chord through the planet.
 */
function graticule(step = 15, density = 3){
  const lines = [];

  for(let lon = -180; lon < 180; lon += step){
    const pts = [];
    for(let lat = -85; lat <= 85; lat += density) pts.push([lon, lat]);
    lines.push(pts);
  }
  for(let lat = -75; lat <= 75; lat += step){
    const pts = [];
    for(let lon = -180; lon <= 180; lon += density) pts.push([lon, lat]);
    lines.push(pts);
  }

  return {
    type: 'FeatureCollection',
    features: lines.map(coordinates => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates },
    })),
  };
}

/* ---------- starfield ---------- */

/**
 * Stars behind the canvas.
 *
 * Drawn once to a canvas rather than built from DOM nodes or box-shadows:
 * a couple of thousand elements would cost more than the globe does. The map
 * canvas is transparent outside the sphere, so this shows through.
 */
export function starfield(canvas){
  const ctx = canvas.getContext('2d');
  let stars = [];

  function seed(w, h){
    // Roughly one star per 2,600 px^2, so density holds on any screen.
    const count = Math.min(1400, Math.round((w * h) / 2600));
    stars = new Array(count);
    for(let i = 0; i < count; i++){
      const r = Math.random();
      stars[i] = {
        x: Math.random() * w,
        y: Math.random() * h,
        // Mostly faint pinpricks, a few bright ones. Squaring the roll keeps
        // big stars rare, which is what makes a field look like a sky.
        r: 0.35 + r * r * 1.5,
        a: 0.25 + Math.random() * 0.6,
        // A cool or warm cast on a minority of them, the rest white.
        hue: Math.random() < 0.12 ? (Math.random() < 0.5 ? 200 : 40) : null,
      };
    }
  }

  function draw(){
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // A module script can evaluate before the canvas has been laid out, and
    // clientWidth is 0 then -- which silently left the field at the canvas
    // default of 300x150 in one corner of the screen.
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    seed(w, h);
    ctx.clearRect(0, 0, w, h);
    for(const s of stars){
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = s.hue === null
        ? `rgba(255,255,255,${s.a})`
        : `hsla(${s.hue},70%,80%,${s.a})`;
      ctx.fill();
    }
  }

  draw();
  // And once more after layout has definitely happened, in case the first
  // pass had to guess at the size.
  requestAnimationFrame(draw);

  let pending;
  const redraw = () => {
    clearTimeout(pending);
    pending = setTimeout(draw, 150);
  };
  window.addEventListener('resize', redraw);
  return draw;
}

/* ---------- idle rotation ---------- */

/**
 * Drift the globe until the visitor touches it.
 *
 * Skipped when the URL already names a location -- someone following a shared
 * link wants to land there, not watch it slide away -- and when the system
 * asks for reduced motion.
 */
export function idleSpin(map, { degreesPerSecond = 3, deepLinked = false } = {}){
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  // `deepLinked` is captured by the caller before the map is constructed:
  // MapLibre writes location.hash as soon as it initialises, so checking it
  // here would always look like a shared link and the globe would never turn.
  if(reduced || deepLinked) return () => {};

  let raf = 0;
  let last = performance.now();
  let stopped = false;

  function stop(){
    if(stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    for(const ev of EVENTS) map.getCanvas().removeEventListener(ev, stop);
  }

  function frame(now){
    if(stopped) return;
    const dt = (now - last) / 1000;
    last = now;
    const c = map.getCenter();
    // jumpTo, not easeTo: an animation per frame would fight itself and the
    // camera would stutter.
    map.jumpTo({ center: [c.lng + degreesPerSecond * dt, c.lat] });
    raf = requestAnimationFrame(frame);
  }

  const EVENTS = ['mousedown', 'touchstart', 'wheel', 'keydown', 'dblclick'];
  for(const ev of EVENTS) map.getCanvas().addEventListener(ev, stop, { passive: true });
  raf = requestAnimationFrame(frame);

  return stop;
}
