/*
   Turning a set of points into lights.

   A light is two stacked circle layers rather than one:

     glow  a big, fully blurred, semi-transparent disc in the saturated hue
     core  a small, barely blurred disc in a whitened version of that hue

   That pairing is what reads as "emitting" instead of "painted on". A single
   circle, however bright, still looks like a sticker on the globe. The core is
   tinted toward white rather than drawn as a third white layer, because on the
   camera layer a third pass would mean another 148,000 circles for an effect
   worth a few pixels.

   Where the glows overlap they accumulate, so a dense city turns into one
   bright smear the way it does from orbit. That is the whole reason the camera
   layer no longer clusters.
*/

/** Mix a hex colour toward white. t=0 returns it unchanged, t=1 returns white. */
export function tint(hex, t){
  const n = parseInt(hex.slice(1), 16);
  const mix = c => Math.round(c + (255 - c) * t);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/**
 * Multiply a radius expression by a constant.
 *
 * Not `['*', expr, k]`: MapLibre only accepts a `zoom` expression at the top
 * level of a property, so wrapping the zoom interpolation in an arithmetic
 * operator is rejected outright. Scaling the interpolation's *outputs* instead
 * produces the same curve and stays legal. Outputs can themselves be
 * data-driven expressions, so this recurses.
 */
function scaleExpr(expr, k){
  if(typeof expr === 'number') return expr * k;
  if(!Array.isArray(expr)) return expr;

  const [op] = expr;
  if(op === 'interpolate' || op === 'interpolate-hcl' || op === 'interpolate-lab'){
    // ['interpolate', type, input, stop, output, stop, output, ...]
    const out = expr.slice(0, 3);
    for(let i = 3; i < expr.length; i += 2) out.push(expr[i], scaleExpr(expr[i + 1], k));
    return out;
  }
  if(op === 'step'){
    // ['step', input, output, stop, output, ...]
    const out = [op, expr[1], scaleExpr(expr[2], k)];
    for(let i = 3; i < expr.length; i += 2) out.push(expr[i], scaleExpr(expr[i + 1], k));
    return out;
  }
  // Anything else (a bare ['get'], a ['case'], a literal) multiplies safely.
  return ['*', expr, k];
}

/** A MapLibre `match` over one property, or a plain colour when there is one. */
function colourExpr(property, stops, fallback, t){
  const shade = hex => (t ? tint(hex, t) : hex);
  if(!property) return shade(fallback);

  const expr = ['match', ['get', property]];
  for(const [value, hex] of stops) expr.push(value, shade(hex));
  expr.push(shade(fallback));
  return expr;
}

/**
 * Build the glow/core pair for one set of points.
 *
 * Returns two layer definitions, bottom first, named `<idPrefix>-glow` and
 * `<idPrefix>-core`. Callers add them in order and keep both ids together
 * wherever visibility or filters are applied.
 */
export function lightLayers({
  idPrefix,
  source,
  property = null,
  stops = [],
  fallback = '#FFFFFF',
  radius,                    // core radius, a number or a zoom expression
  glowScale = 3,             // glow radius as a multiple of the core
  glowOpacity = 0.3,
  coreOpacity = 0.95,
  coreTint = 0.5,
  coreBlur = 0.35,
  filter = null,
  minzoom,
  stroke = null,             // {colour, width} for a ring around the core
}){
  const glow = {
    id: `${idPrefix}-glow`,
    type: 'circle',
    source,
    paint: {
      'circle-color': colourExpr(property, stops, fallback, 0),
      'circle-radius': scaleExpr(radius, glowScale),
      // 1 means the blur reaches the full radius: no hard edge anywhere.
      'circle-blur': 1,
      'circle-opacity': glowOpacity,
      'circle-pitch-alignment': 'map',
    },
  };

  const core = {
    id: `${idPrefix}-core`,
    type: 'circle',
    source,
    paint: {
      'circle-color': colourExpr(property, stops, fallback, coreTint),
      'circle-radius': radius,
      'circle-blur': coreBlur,
      'circle-opacity': coreOpacity,
      'circle-pitch-alignment': 'map',
    },
  };

  if(stroke){
    core.paint['circle-stroke-color'] = stroke.colour;
    core.paint['circle-stroke-width'] = stroke.width;
    if(stroke.opacity != null) core.paint['circle-stroke-opacity'] = stroke.opacity;
  }

  for(const layer of [glow, core]){
    if(filter) layer.filter = filter;
    if(minzoom != null) layer.minzoom = minzoom;
  }

  return [glow, core];
}
