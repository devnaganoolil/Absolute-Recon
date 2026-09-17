/*
   The layer panel: one section per data layer, each with a master switch and
   whatever filters that layer exposes.

   The panel knows nothing about any particular layer.  It renders whatever
   `filters()`, `range` and `legend()` return, so adding a fourth data source
   means writing a module, not touching this file.
*/

import { $, esc, num } from './util.js';

let host, layers, callbacks;

export function init(registry, hooks){
  host = $('panel-body');
  layers = registry;
  callbacks = hooks;

  $('panel-toggle').onclick = () => setOpen(!isOpen());
  $('panel-close').onclick = () => setOpen(false);

  // Escape closes the panel, but not while the user is mid-search.
  document.addEventListener('keydown', e => {
    if(e.key === 'Escape' && isOpen() && document.activeElement !== $('q')) setOpen(false);
  });

  render();
}

const isOpen = () => !$('panel').hidden;

export function setOpen(open){
  $('panel').hidden = !open;
  $('panel-toggle').setAttribute('aria-expanded', String(open));
}

/** Rebuild the whole panel. Cheap -- a few dozen nodes -- and avoids drift. */
export function render(){
  host.innerHTML = '';

  for(const layer of layers){
    const on = callbacks.isOn(layer.id);
    const state = callbacks.stateOf(layer.id);

    const section = document.createElement('section');
    section.className = 'layer' + (on ? ' on' : '');

    const head = document.createElement('div');
    head.className = 'layer-head';

    const sw = document.createElement('label');
    sw.className = 'switch';
    // autocomplete="off" matters here: on a plain reload both Chrome and
    // Firefox restore previous checkbox states and fire change events for
    // them, which silently overrode the remembered layer choices and left the
    // panel disagreeing with the map.
    sw.innerHTML = `
      <input type="checkbox" autocomplete="off" ${on ? 'checked' : ''}
             aria-label="Show ${esc(layer.label)}">
      <span class="track" style="--accent:${layer.colour}"></span>
      <span class="switch-text">
        <span class="switch-title">${esc(layer.label)}</span>
        <span class="switch-sub">${esc(layer.blurb)}</span>
      </span>`;
    sw.querySelector('input').onchange = e => callbacks.setLayer(layer.id, e.target.checked);
    head.appendChild(sw);
    section.appendChild(head);

    if(state === 'loading'){
      section.insertAdjacentHTML('beforeend',
        `<p class="layer-note">Loading…</p>`);
    }else if(state === 'error'){
      section.insertAdjacentHTML('beforeend',
        `<p class="layer-note err">Couldn’t load this data.</p>`);
    }else if(on && state === 'ready'){
      section.appendChild(body(layer));
    }

    host.appendChild(section);
  }
}

function body(layer){
  const wrap = document.createElement('div');
  wrap.className = 'layer-body';

  for(const group of layer.filters()){
    if(!group.items.length) continue;

    const g = document.createElement('div');
    g.className = 'fgroup';
    g.innerHTML = `<p class="fgroup-title">${esc(group.title)}</p>`;

    const chips = document.createElement('div');
    chips.className = 'chips';

    for(const item of group.items){
      const el = document.createElement('button');
      el.className = 'chip';
      el.type = 'button';
      el.setAttribute('aria-pressed', String(item.on));
      if(item.title) el.title = item.title;
      el.innerHTML =
        `<span class="dot" style="background:${item.colour}"></span>` +
        `${esc(item.label)}` +
        (item.count != null ? ` <span class="n">${num(item.count)}</span>` : '') +
        (item.note ? ` <span class="note">${esc(item.note)}</span>` : '');
      el.onclick = () => {
        const next = el.getAttribute('aria-pressed') !== 'true';
        el.setAttribute('aria-pressed', String(next));
        callbacks.setFilter(layer.id, item.key, next);
      };
      chips.appendChild(el);
    }

    g.appendChild(chips);
    wrap.appendChild(g);
  }

  if(layer.range){
    const g = document.createElement('div');
    g.className = 'fgroup';
    g.innerHTML = `<p class="fgroup-title">${esc(layer.range.title)}</p>`;

    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.setAttribute('role', 'group');
    for(const opt of layer.range.options){
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = opt.label;
      b.setAttribute('aria-pressed', String(opt.key === layer.range.value));
      b.onclick = () => callbacks.setRange(layer.id, opt.key);
      seg.appendChild(b);
    }
    g.appendChild(seg);
    wrap.appendChild(g);
  }

  const legend = layer.legend?.();
  if(legend){
    wrap.insertAdjacentHTML('beforeend',
      `<p class="layer-note">${esc(legend.note)}
        <a href="${esc(legend.url)}" target="_blank" rel="noopener">${esc(legend.source)}</a></p>`);
  }

  return wrap;
}
