# Absolute Recon

One map, three datasets:

- **ALPR cameras** — community-reported automated license plate reader
  locations (Flock Safety, Motorola/Vigilant, Genetec, Leonardo/ELSAG and
  unlabelled installs), from OpenStreetMap.
- **Armed conflict** — reported political violence worldwide, from the Uppsala
  Conflict Data Program: the active conflicts, and the individual events behind
  them.
- **Natural disasters** — current earthquakes, wildfires, storms, floods,
  volcanoes and drought, merged from USGS, NASA and GDACS.

Each is a layer you can switch on and off independently.

Live site: _(fill in once Cloudflare Pages is connected)_

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

Rendering is MapLibre GL, so clustering runs on the GPU and comfortably handles
the full worldwide dataset.

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

## Deploying to Cloudflare Pages

1. Push this repo to GitHub.
2. In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to
   Git**, and pick the repo.
3. Build settings — there is no build step:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `/`
4. Deploy.

`_headers` is picked up automatically. Each refresh Action commits its
regenerated data file, and that push triggers a new Pages deploy.

The Actions need no secrets — they use the built-in `GITHUB_TOKEN` — but the
repo must allow them to push: **Settings → Actions → General → Workflow
permissions → Read and write permissions**.

Three jobs now push to the same branch, so each one rebases and retries before
giving up; the disaster refresh runs every three hours and would otherwise lose
races with the weekly jobs.
