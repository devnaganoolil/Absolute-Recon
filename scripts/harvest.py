#!/usr/bin/env python3
"""
Harvest every ALPR camera in OpenStreetMap into one compact static file.

The public Overpass instances will not serve the whole planet in a single
query, and they must not be queried from the browser on every map move.  So we
pull the data once here, on a schedule, and the site ships the result.

Strategy: recursive quadtree.  Ask for a big box; if the server says it is too
big or too slow, cut the box into four and retry the pieces.  Ocean cells come
back empty in one request, and dense metros subdivide a few levels deep, so the
total request count stays low without us hard-coding where the cameras are.

Output: data/cameras.json -- arrays-of-arrays with interned strings, which is
about a quarter the size of equivalent GeoJSON.  The page converts it to
GeoJSON at load time.
"""

import json
import gzip
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "cameras.json"

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

UA = "FlockCamerasNearMe/1.0 (static site data build; +https://github.com/)"

# Overpass server-side timeout per request, seconds.
QUERY_TIMEOUT = 180
# Stop subdividing past this; a cell this small that still fails is a real error.
MIN_SPAN = 0.05
# Politeness delay between requests, seconds.
DELAY = 2.0

BRANDS = [
    ("flock", re.compile(r"flock", re.I)),
    ("motorola", re.compile(r"motorola|vigilant", re.I)),
    ("genetec", re.compile(r"genetec|autovu", re.I)),
    ("elsag", re.compile(r"elsag|leonardo", re.I)),
    ("other", None),
]


class TooBig(Exception):
    """The server refused this box; caller should subdivide."""


class Fatal(Exception):
    """A local misconfiguration. Subdividing will not help; stop."""


def make_ssl_context():
    ctx = ssl.create_default_context()
    if ctx.cert_store_stats().get("x509_ca", 0):
        return ctx
    try:
        import certifi
    except ImportError:
        raise Fatal(
            "No CA certificates available to Python.\n"
            "  macOS fix: run '/Applications/Python 3.12/Install Certificates.command'\n"
            "  or: python3 -m pip install certifi"
        )
    return ssl.create_default_context(cafile=certifi.where())


SSL_CTX = make_ssl_context()


def query(south, west, north, east):
    bbox = f"{south:.5f},{west:.5f},{north:.5f},{east:.5f}"
    q = (
        f"[out:json][timeout:{QUERY_TIMEOUT}];"
        f'(node["man_made"="surveillance"]["surveillance:type"~"ALPR",i]({bbox});'
        f'way["man_made"="surveillance"]["surveillance:type"~"ALPR",i]({bbox}););'
        f"out tags center;"
    )
    body = ("data=" + urllib.parse.quote(q)).encode()

    last = None
    for attempt in range(6):
        url = ENDPOINTS[attempt % len(ENDPOINTS)]
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": UA,
                "Accept-Encoding": "gzip",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=QUERY_TIMEOUT + 60, context=SSL_CTX) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                text = raw.decode("utf-8", "replace")

            # Overpass reports some failures as HTML with a 200 status.
            if text.lstrip().startswith("<"):
                if "too busy" in text or "timeout" in text.lower():
                    last = "server busy"
                    time.sleep(5 + attempt * 5)
                    continue
                raise TooBig(text[:200])

            return json.loads(text)["elements"]

        except urllib.error.HTTPError as e:
            # 400 here means the box blew the memory/time limit -> subdivide.
            if e.code == 400:
                raise TooBig(f"HTTP 400 on {bbox}")
            last = f"HTTP {e.code}"
            time.sleep(5 + attempt * 5)
        except TooBig:
            raise
        except urllib.error.URLError as e:
            if isinstance(e.reason, ssl.SSLError):
                raise Fatal(f"TLS failure talking to {url}: {e.reason}")
            last = str(e)
            time.sleep(5 + attempt * 5)
        except Exception as e:  # malformed JSON, socket timeout
            last = str(e)
            time.sleep(5 + attempt * 5)

    # Every endpoint failed repeatedly. Treat as "too big" so we subdivide and
    # retry smaller rather than losing the whole region.
    raise TooBig(f"all endpoints failed for {bbox}: {last}")


def harvest(south, west, north, east, seen, depth=0):
    """Fetch one box, subdividing on refusal. Mutates `seen`."""
    pad = "  " * depth
    label = f"{south:.2f},{west:.2f} -> {north:.2f},{east:.2f}"
    try:
        els = query(south, west, north, east)
    except TooBig as e:
        if min(north - south, east - west) <= MIN_SPAN:
            print(f"{pad}!! giving up on {label}: {e}", flush=True)
            return
        print(f"{pad}~~ splitting {label}", flush=True)
        mid_lat = (south + north) / 2
        mid_lon = (west + east) / 2
        time.sleep(DELAY)
        harvest(south, west, mid_lat, mid_lon, seen, depth + 1)
        harvest(south, mid_lon, mid_lat, east, seen, depth + 1)
        harvest(mid_lat, west, north, mid_lon, seen, depth + 1)
        harvest(mid_lat, mid_lon, north, east, seen, depth + 1)
        return

    new = 0
    for el in els:
        lat = el.get("lat")
        lon = el.get("lon")
        if lat is None:
            c = el.get("center") or {}
            lat, lon = c.get("lat"), c.get("lon")
        if lat is None or lon is None:
            continue
        key = (el["type"], el["id"])
        if key in seen:
            continue
        seen[key] = (lat, lon, el.get("tags") or {})
        new += 1

    # Always log. A silent multi-hour job is indistinguishable from a hung one,
    # and most cells legitimately come back empty.
    print(f"{pad}   {label}: {len(els)} returned, {new} new (total {len(seen)})", flush=True)
    time.sleep(DELAY)


def brand_of(tags):
    hay = " ".join(
        str(tags.get(k, ""))
        for k in ("manufacturer", "brand", "operator", "name", "manufacturer:wikidata")
    ).lower()
    for i, (_, pattern) in enumerate(BRANDS):
        if pattern and pattern.search(hay):
            return i
    return len(BRANDS) - 1


def main():
    seen = {}
    started = time.time()

    # Eight top-level boxes; the quadtree takes it from here.
    for south, west, north, east in [
        (-90, -180, 0, -90), (-90, -90, 0, 0), (-90, 0, 0, 90), (-90, 90, 0, 180),
        (0, -180, 90, -90), (0, -90, 90, 0), (0, 0, 90, 90), (0, 90, 90, 180),
    ]:
        harvest(south, west, north, east, seen)

    if not seen:
        print("ERROR: harvested nothing; refusing to overwrite existing data.", file=sys.stderr)
        return 1

    write(seen, started)
    return 0


def write(seen, started=None):
    # Intern the repeated strings -- operator and manufacturer especially.
    pools = {"mfr": [], "op": [], "mount": [], "type": []}
    index = {k: {} for k in pools}

    def intern(pool, value):
        if not value:
            return -1
        value = str(value)[:80]
        if value not in index[pool]:
            index[pool][value] = len(pools[pool])
            pools[pool].append(value)
        return index[pool][value]

    rows = []
    for (osm_type, osm_id), (lat, lon, tags) in seen.items():
        direction = tags.get("direction", "")
        try:
            direction = int(float(direction))
        except (TypeError, ValueError):
            direction = -1
        rows.append([
            round(lat, 5),
            round(lon, 5),
            brand_of(tags),
            intern("mfr", tags.get("manufacturer") or tags.get("brand")),
            intern("op", tags.get("operator")),
            direction,
            intern("mount", tags.get("support") or tags.get("camera:mount")),
            intern("type", tags.get("surveillance:type")),
            0 if osm_type == "node" else 1,
            osm_id,
        ])

    # Sort north-to-south so gzip sees runs of similar latitudes.
    rows.sort(key=lambda r: (-r[0], r[1]))

    payload = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "count": len(rows),
        "brands": [b[0] for b in BRANDS],
        "fields": ["lat", "lon", "brand", "mfr", "op", "dir", "mount", "type", "osmType", "osmId"],
        "pools": pools,
        "rows": rows,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    tmp.replace(OUT)

    raw = OUT.stat().st_size
    packed = len(gzip.compress(OUT.read_bytes(), 9))
    took = f", in {(time.time() - started) / 60:.1f} min" if started else ""
    print(
        f"\nWrote {OUT.relative_to(ROOT)}: {len(rows):,} cameras, "
        f"{raw/1e6:.1f} MB raw / {packed/1e6:.1f} MB gzipped{took}"
    )
    return payload


if __name__ == "__main__":
    sys.exit(main())
