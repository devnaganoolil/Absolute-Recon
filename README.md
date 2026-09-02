# Plate Reader Map

A public map of community-reported automated license plate reader (ALPR) camera
locations — Flock Safety, Motorola/Vigilant, Genetec, Leonardo/ELSAG and
unlabelled installs — built from OpenStreetMap data.

Live site: _(fill in once Cloudflare Pages is connected)_

## How it works

The site is one static HTML file plus one static data file. It makes **no API
calls for camera data at runtime**, which is the whole point of the design:

- The public [Overpass](https://overpass-api.de/) instances explicitly forbid
  being queried from a browser on map movement, and will rate-limit or block
  visitors of an app that does. So `scripts/harvest.py` pulls the whole dataset
  on a weekly schedule instead, and the site ships the result.
- The basemap is [OpenFreeMap](https://openfreemap.org/) — keyless and
  unmetered. `tile.openstreetmap.org` is *not* usable here; OSM's tile policy
  bars high-traffic apps, and CARTO's keyless tiles are watermarked.
- Place search uses [Photon](https://photon.komoot.io/), which permits public
  app use, falling back to Nominatim only if Photon is unreachable. Both are hit
  only when a visitor actually submits a search.

Rendering is MapLibre GL, so clustering runs on the GPU and comfortably handles
the full worldwide dataset.

## Layout

```
index.html                        the entire site
data/cameras.json                 generated dataset, committed
scripts/harvest.py                Overpass harvester
.github/workflows/refresh-data.yml  weekly regeneration
_headers                          Cloudflare Pages cache + security headers
```

## Running locally

```bash
python3 -m http.server 8777
```

Then open <http://localhost:8777/>. Serve it over HTTP rather than opening the
file directly — a `file://` page has a `null` origin, which breaks the geocoder
requests and geolocation.

## Refreshing the data by hand

```bash
python3 scripts/harvest.py
```

It walks the planet as a quadtree: it asks Overpass for a large bounding box
and, when the server refuses one as too large, splits it into four and retries.
Ocean returns empty in a single request; dense metros subdivide a few levels.
Expect it to take a while — Overpass is frequently busy, and the script backs
off and rotates between three mirrors rather than hammering one.

The output is arrays-of-arrays with interned strings, roughly a quarter the size
of the equivalent GeoJSON. `index.html` expands it to GeoJSON at load time.

If it fails immediately with a TLS error on macOS, Python has no CA bundle
wired up:

```bash
/Applications/Python\ 3.12/Install\ Certificates.command
```

## Deploying to Cloudflare Pages

1. Push this repo to GitHub.
2. In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to
   Git**, and pick the repo.
3. Build settings — there is no build step:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `/`
4. Deploy.

`_headers` is picked up automatically. The weekly GitHub Action commits a
refreshed `data/cameras.json`, and that push triggers a new Pages deploy.

The Action needs no secrets — it uses the built-in `GITHUB_TOKEN` — but the
repo must allow it to push: **Settings → Actions → General → Workflow
permissions → Read and write permissions**.

## Data, licensing, and caveats

Camera data comes from OpenStreetMap and is licensed
[ODbL](https://www.openstreetmap.org/copyright). The attribution in the page
footer is a licence condition — please keep it.

**Coverage is crowdsourced and incomplete.** A blank area means nobody has
mapped it, not that it has no cameras. Positions and manufacturer labels are
contributor-reported and can be wrong or out of date. Treat this as a rough
public-awareness tool, not an authoritative registry.

To correct or add a camera, edit it in OpenStreetMap — every marker links
through to its OSM object. Changes appear here after the next weekly refresh.
