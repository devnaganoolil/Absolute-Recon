# Absolute Recon

The night side of the planet, with three datasets lit up on it:

- **ALPR cameras** — community-reported automated license plate reader
  locations (Flock Safety, Motorola/Vigilant, Genetec, Leonardo/ELSAG and
  unlabelled installs), from OpenStreetMap.
- **Armed conflict** — reported political violence worldwide, from the Uppsala
  Conflict Data Program: the active conflicts, and the individual events behind
  them.
- **Natural disasters** — current earthquakes, wildfires, storms, floods,
  volcanoes and drought, merged from USGS, NASA and GDACS.

Each is a layer you can switch on and off independently, and each point is
drawn as a light rather than a marker — so at world zoom the data reads the way
city lights do from orbit, and the colour tells you what kind of light it is.

Live site: <https://devnaganoolil.github.io/Absolute-Recon/>

## How it works

The site is static. No server, no build step, no API keys. Every dataset is
harvested on a schedule by a script in `scripts/`, committed as a compact JSON
file, and shipped as-is.

Nothing is fetched from a data API at runtime, which is deliberate for the
cameras: the public [Overpass](https://overpass-api.de/) instances explicitly
forbid being queried from a browser on map movement, and will rate-limit or
block visitors of an app that does.

The disaster feeds are keyless *and* CORS-open, so that layer could refresh
live in the browser. It doesn't, on purpose — normalising three unrelated
schemas into one shape is most of `harvest_disasters.py`, and doing it again in
JavaScript would mean two copies of the same category mapping, free to drift
apart. The Action re-runs every three hours instead, which is fresh enough for
a map whose shortest-lived hazard is a wildfire.

Rendering is MapLibre GL v5 with its globe projection, so this is a projection
on a normal map rather than a separate 3D engine — every layer, filter and popup
is ordinary MapLibre and simply wraps onto a sphere.

The basemap style is hand-written rather than pulled from OpenFreeMap, because
none of theirs is dark enough to be a night side. It draws only what the globe
needs: near-black land, darker water, a faint lit coastline, country borders and
a graticule. Everything bright on screen is supposed to be the data.

Each point is two stacked circle layers — a wide fully-blurred disc in the
saturated hue, and a small nearly-sharp one in a whitened version of it. That
pairing is what reads as *emitting*; a single bright circle still looks like a
sticker on the planet. Where the glows overlap they pile up, so a dense metro
turns into one bright smear on its own.

That is also why the camera layer no longer clusters. Clustering 148,805 points
is the obvious call and the wrong one here: the clusters were opaque discs with
counts in them, and the whole reason this layer is worth looking at is the
carpet. Unclustered and at 60fps, the lights trace out every lit corridor in
North America and Europe without being told where the cities are.

Supporting services, all of which permit public app use:

- Basemap is [OpenFreeMap](https://openfreemap.org/) — keyless and unmetered.
  `tile.openstreetmap.org` is *not* usable here; OSM's tile policy bars
  high-traffic apps, and CARTO's keyless tiles are watermarked.
- Place search uses [Photon](https://photon.komoot.io/), falling back to
  Nominatim only if Photon is unreachable. Both are hit only when a visitor
  actually submits a search.

## Layout

```
index.html                           the page shell and all the styling
js/main.js                           boot, layer lifecycle, stacking order
js/globe.js                          globe style, atmosphere, starfield, spin
js/lights.js                         turning points into glow/core light pairs
js/panel.js                          the layers & filters panel
js/cameras.js  js/conflicts.js  js/disasters.js
                                     one module per dataset
js/search.js   js/util.js            geocoding; shared helpers

data/cameras.json                    ~149k cameras   (~7.6 MB, ~2 MB gzipped)
data/conflicts.json                  ~51k events     (~6.6 MB, ~1.8 MB gzipped)
data/disasters.json                  ~2.8k events    (~1 MB, ~125 kB gzipped)

scripts/harvest.py                   Overpass  -> cameras.json
scripts/harvest_conflicts.py         UCDP      -> conflicts.json
scripts/harvest_disasters.py         USGS/NASA/GDACS -> disasters.json

.github/workflows/refresh-data.yml       cameras, weekly
.github/workflows/refresh-conflicts.yml  conflict, weekly
.github/workflows/refresh-disasters.yml  disasters, every 3 hours

_headers                             Cloudflare Pages cache + security headers
```

The modules are plain ES modules loaded natively — there is still no bundler.
Cameras load at boot; the other two are fetched the first time their layer is
switched on, so adding them costs a first-time visitor nothing.

Each layer module exports the same small interface (`load`, `addLayers`,
`filters`, `applyFilter`, `popup`, `legend`), and `panel.js` renders whatever
those return. Adding a fourth dataset means writing a module and adding it to
the `LAYERS` array in `main.js` — the panel needs no changes.

Two ordering rules matter. Every layer's *glow* is painted below every layer's
*core*, so one layer's halo never washes out another's bright centre; `STACK` in
`main.js` is the single place that decides this, and it is re-applied after each
lazily-loaded layer arrives. And since all three layers are now lights rather
than dots, circles and icons, the ring around orange- and red-alert disasters is
what keeps them distinguishable from conflict — nothing else on the globe has
one.

## Running locally

```bash
python3 -m http.server 8777
```

Then open <http://localhost:8777/>. Serve it over HTTP rather than opening the
file directly — a `file://` page has a `null` origin, which breaks ES module
imports, the geocoder requests and geolocation.

## Refreshing the data by hand

```bash
python3 scripts/harvest.py            # cameras     (minutes)
python3 scripts/harvest_conflicts.py  # conflict    (~2 min, ~80 MB of CSV)
python3 scripts/harvest_disasters.py  # disasters   (seconds)
```

If any of them fails immediately with a TLS error on macOS, Python has no CA
bundle wired up:

```bash
/Applications/Python\ 3.12/Install\ Certificates.command
```

### Cameras

ALPR is a rare tag — about 150k features worldwide — so the script first asks
Overpass for the entire planet in a single query. That normally succeeds in two
or three minutes.

If Overpass refuses it (busy server, or a future dataset large enough to blow
the memory limit), it falls back to walking a 30° grid as a quadtree,
subdividing only the boxes the server rejects. That path is much slower, so it
checkpoints to `data/.harvest-state.json` every 20 cells and a re-run resumes
where it left off. Either way the script backs off and rotates between three
mirrors rather than hammering one.

### Conflict

Source is UCDP's Georeferenced Event Dataset, "candidate" release — their
near-real-time stream, published monthly and consolidated quarterly.

As of 2026 the UCDP *API* requires a per-user access token, but the release
files under `ucdp.uu.se/downloads` are still open, so the harvester reads those
and the Action needs no secret. UCDP publishes each year under two naming
schemes and neither is a strict superset of the other, so the script pulls both
and unions by event id. Downloads are cached in `data/.ucdp-cache/` (gitignored)
because a published release file never changes.

### Disasters

Three feeds, because no single one covers the field:

| Source | Contributes | Why it is here |
| --- | --- | --- |
| [USGS](https://earthquake.usgs.gov/) | Earthquakes M4.0+ | Authoritative and near-real-time; nothing else is close for seismicity |
| [NASA EONET](https://eonet.gsfc.nasa.gov/) | Wildfires, volcanoes, storms, ice | Satellite-derived, so it sees fires nobody reported |
| [GDACS](https://www.gdacs.org/) | Floods, cyclones, drought, alert levels | The only one scoring *humanitarian* impact, and the only good source for floods and drought |

EONET has `earthquakes` and `floods` categories in its API, but both sit empty
in practice — which is exactly why the other two feeds are there.

Earthquakes come through the FDSN query API rather than a ready-made summary
feed, because the summary feeds stop at 30 days. The M4.0 floor keeps the layer
to quakes a person could feel; M2.5+ is around 4,900 events in 60 days, almost
all instrument-only, and they bury every other hazard on the map.

## Reading the data honestly

Every layer has a different failure mode, and the map tries to say so rather
than let you assume.

**Cameras are crowdsourced and incomplete.** A blank area means nobody has
mapped it, not that it has no cameras. Positions and manufacturer labels are
contributor-reported and can be wrong or out of date. To correct or add one,
edit it in OpenStreetMap — every marker links through to its OSM object.
Changes appear here after the next weekly refresh.

**Conflict data lags real time by roughly two months.** UCDP codes events from
news reporting, so the most recent weeks are simply not in the dataset yet. The
"events in the most recent 30 days" filter therefore counts back from the newest
event in the file, not from today — counting back from today returned nothing,
which reads as "no violence last month" instead of "not coded yet".

**Conflict locations are often approximate.** UCDP records how precisely it
knows each one, and anything it placed at province level or coarser is drawn as
a hollow ring and labelled as approximate in its popup. Some large death tolls
are country-level aggregates sitting on a country centroid, not a place where
that many people died in one spot.

**The conflict list is derived, not curated.** A conflict appears because UCDP
recorded deadly events in it inside the window, which keeps the layer honest
and self-updating. The flip side: a *dormant* territorial dispute with no recent
casualties — Taiwan, most of the South China Sea claims, the quieter stretches
of the Line of Control — is not in here at all. This layer is "where organised
violence is being reported", not "every disputed border in the world".

**Volcanoes and drought outlive the 60-day disaster window.** Both sources model
them as one long-running event updated only when the situation changes, so they
are kept while the source still lists them as active, and the popup says when
each was last updated.

**Death tolls are estimates.** UCDP's `best` figure is shown; their low and high
bounds can be far apart, especially in the first reports of an incident.

Treat the whole thing as a rough public-awareness tool, not an authoritative
registry.

## Data, licensing, and attribution

| Dataset | Source | Licence |
| --- | --- | --- |
| Cameras | OpenStreetMap contributors | [ODbL](https://www.openstreetmap.org/copyright) |
| Conflict | [UCDP](https://ucdp.uu.se/) GED candidate release | CC BY 4.0 |
| Earthquakes | [USGS](https://earthquake.usgs.gov/) | Public domain |
| Wildfires, volcanoes, storms | [NASA EONET](https://eonet.gsfc.nasa.gov/) | Public domain |
| Disaster alerts | [GDACS](https://www.gdacs.org/) | © European Union |
| Basemap | [OpenFreeMap](https://openfreemap.org/) / OpenMapTiles | ODbL |

The attribution in the page footer is a licence condition for several of these
— please keep it.

## Deploying

The site is plain static files at the repo root with no build step, so it
deploys anywhere that serves a directory. Every asset path is relative, which
means it works just as well under a subpath (`/Absolute-Recon/`) as at a
domain root — don't change that without checking both.

### GitHub Pages (current)

Settings → Pages → Source: **Deploy from a branch**, branch `main`, folder
`/ (root)`. Live at <https://devnaganoolil.github.io/Absolute-Recon/>.

Three things to know:

- `.nojekyll` is required. Without it GitHub runs the files through Jekyll,
  which silently drops anything whose name starts with an underscore.
- GitHub Pages has no header configuration, so `_headers` does nothing there
  and everything is served with GitHub's own ~10 minute CDN cache. That is
  fine here — a data refresh appears within ten minutes — but it does mean the
  short cache the disaster feed wants is not in effect.
- Pages on a **private** repo needs a paid plan. This repo is public, which is
  what makes the free tier work.

### Cloudflare Pages

1. Push this repo to GitHub.
2. In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to
   Git**, and pick the repo.
3. Build settings — there is no build step:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `/`
4. Deploy.

`_headers` is picked up automatically there (unlike GitHub Pages). Each
refresh Action commits its regenerated data file, and that push triggers a new
deploy on whichever host is connected.

The Actions need no secrets — they use the built-in `GITHUB_TOKEN` — but the
repo must allow them to push: **Settings → Actions → General → Workflow
permissions → Read and write permissions**.

Three jobs now push to the same branch, so each one rebases and retries before
giving up; the disaster refresh runs every three hours and would otherwise lose
races with the weekly jobs.
