/*
   Place search.

   Photon permits public app use and is tried first; Nominatim is the fallback
   and is only touched when Photon is unreachable.  Both are hit only when a
   visitor actually submits a search, never on map movement.
*/

import { $, esc, say } from './util.js';

let seq = 0;

export function wire(map){
  const submit = () => {
    const v = $('q').value.trim();
    if(v) search(v, map);
  };

  $('go').onclick = submit;
  $('q').addEventListener('keydown', e => {
    if(e.key === 'Enter'){ e.preventDefault(); submit(); }
    if(e.key === 'Escape') showHits([], map);
  });
  document.addEventListener('click', e => {
    if(!$('hits').contains(e.target) && e.target !== $('q')) showHits([], map);
  });

  $('locate').onclick = () => {
    if(!navigator.geolocation){ say('This browser can’t share a location.', 'err'); return; }
    say('Finding you…', 'busy');
    navigator.geolocation.getCurrentPosition(
      p => { say(''); map.flyTo({ center:[p.coords.longitude, p.coords.latitude], zoom:14 }); },
      () => say('Location permission was denied.', 'err'),
      { enableHighAccuracy:true, timeout:10000 }
    );
  };
}

async function search(text, map){
  const mine = ++seq;
  say('Looking up that place…', 'busy');
  let hits = [];

  try{
    const r = await fetch('https://photon.komoot.io/api/?limit=5&q=' + encodeURIComponent(text));
    if(r.ok){
      const j = await r.json();
      hits = (j.features || []).map(f => ({
        name: f.properties.name,
        sub: [f.properties.city, f.properties.state, f.properties.country].filter(Boolean).join(', '),
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
        extent: f.properties.extent,          // [w, n, e, s]
      }));
    }
  }catch{ /* fall through to Nominatim */ }

  if(!hits.length){
    try{
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=5&q=' +
                            encodeURIComponent(text));
      const j = await r.json();
      hits = j.map(h => ({
        name: h.display_name.split(',')[0],
        sub: h.display_name.split(',').slice(1, 3).join(',').trim(),
        lon: +h.lon, lat: +h.lat,
        bbox: h.boundingbox,                   // [s, n, w, e]
      }));
    }catch{ /* nothing left to try */ }
  }

  if(mine !== seq) return;                     // a newer search superseded this
  if(!hits.length){ say('No match for that place.', 'err'); showHits([], map); return; }

  say('');
  if(hits.length === 1) return void goTo(hits[0], map);
  showHits(hits, map);
}

function goTo(h, map){
  showHits([], map);
  if(h.extent){
    const [w, n, e, s] = h.extent;
    map.fitBounds([[w, s], [e, n]], { padding:60, maxZoom:15, duration:900 });
  }else if(h.bbox){
    const [s, n, w, e] = h.bbox.map(Number);
    map.fitBounds([[w, s], [e, n]], { padding:60, maxZoom:15, duration:900 });
  }else{
    map.flyTo({ center:[h.lon, h.lat], zoom:13 });
  }
}

function showHits(hits, map){
  const box = $('hits');
  if(!hits.length){ box.hidden = true; box.innerHTML = ''; return; }

  box.innerHTML = '';
  for(const h of hits){
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.innerHTML = `${esc(h.name)}<span class="sub">${esc(h.sub || '')}</span>`;
    b.onclick = () => goTo(h, map);
    box.appendChild(b);
  }
  // Sit the dropdown just under the search field.
  box.style.top = ($('q').getBoundingClientRect().bottom + 6) + 'px';
  box.hidden = false;
}
