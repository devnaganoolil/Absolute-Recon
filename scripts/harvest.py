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

UA = "AbsoluteRecon/1.0 (static site data build; +https://github.com/devnaganoolil/Absolute-Recon)"

# Overpass server-side timeout per request, seconds.
QUERY_TIMEOUT = 180
# The whole planet in one request. ALPR is a rare tag -- about 150k features
# worldwide -- so this usually succeeds in a couple of minutes and makes the
# bounding-box walk below unnecessary.
GLOBAL_TIMEOUT = 1200
# Stop subdividing past this; a cell this small that still fails is a real error.
MIN_SPAN = 0.05
# Politeness delay between requests, seconds.
DELAY = 2.0
# Degrees per side of the starting grid.  Small enough that Overpass accepts
# most cells outright -- subdividing is far more expensive than an extra
# request, because each refusal costs a full round of backoff first.
TOP_STEP = 30
# Attempts before we give up and subdivide instead of retrying.
ATTEMPTS = 3
# Where partial progress is checkpointed, so an interrupted run resumes.
STATE = ROOT / "data" / ".harvest-state.json"
# Flush the checkpoint every this many completed cells.
FLUSH_EVERY = 20

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


def build_query(box=None, timeout=QUERY_TIMEOUT):
    """Overpass QL for one bounding box, or for the whole planet when box is None."""
    clip = ""
    if box is not None:
        south, west, north, east = box
        clip = f"({south:.5f},{west:.5f},{north:.5f},{east:.5f})"
    return (
        f"[out:json][timeout:{timeout}];"
        f'(node["man_made"="surveillance"]["surveillance:type"~"ALPR",i]{clip};'
        f'way["man_made"="surveillance"]["surveillance:type"~"ALPR",i]{clip};);'
        f"out tags center;"
    )


def query(south, west, north, east):
    return _run(build_query((south, west, north, east)), QUERY_TIMEOUT)


def _run(q, timeout):
    body = ("data=" + urllib.parse.quote(q)).encode()

    last = None
    for attempt in range(ATTEMPTS):
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
            with urllib.request.urlopen(req, timeout=timeout + 120, context=SSL_CTX) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                text = raw.decode("utf-8", "replace")

            # Overpass reports some failures as HTML with a 200 status.
            if text.lstrip().startswith("<"):
                if "too busy" in text or "timeout" in text.lower():
                    last = "server busy"
                    time.sleep(4 * (attempt + 1))
                    continue
                raise TooBig(text[:200])

            return json.loads(text)["elements"]

        except urllib.error.HTTPError as e:
            # 400 here means the box blew the memory/time limit -> subdivide.
            if e.code == 400:
                raise TooBig("HTTP 400 (query refused)")
            last = f"HTTP {e.code}"
            time.sleep(4 * (attempt + 1))
        except TooBig:
            raise
        except urllib.error.URLError as e:
            if isinstance(e.reason, ssl.SSLError):
                raise Fatal(f"TLS failure talking to {url}: {e.reason}")
            last = str(e)
            time.sleep(4 * (attempt + 1))
        except Exception as e:  # malformed JSON, socket timeout
            last = str(e)
            time.sleep(4 * (attempt + 1))

    # Every endpoint failed repeatedly. Treat as "too big" so we subdivide and
    # retry smaller rather than losing the whole region.
    raise TooBig(f"all endpoints failed: {last}")


def cell_key(south, west, north, east):
    return f"{south:.5f},{west:.5f},{north:.5f},{east:.5f}"


def harvest(south, west, north, east, seen, depth=0, done=None, tick=None):
    """Fetch one box, subdividing on refusal. Mutates `seen`."""
    pad = "  " * depth
    label = f"{south:.2f},{west:.2f} -> {north:.2f},{east:.2f}"

    key = cell_key(south, west, north, east)
    if done is not None and key in done:
        print(f"{pad}   {label}: skipped (already harvested)", flush=True)
        return

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
        for box in (
            (south, west, mid_lat, mid_lon),
            (south, mid_lon, mid_lat, east),
            (mid_lat, west, north, mid_lon),
            (mid_lat, mid_lon, north, east),
        ):
            harvest(*box, seen, depth + 1, done, tick)
        return

    new = absorb(els, seen)

    # Always log. A silent multi-hour job is indistinguishable from a hung one,
    # and most cells legitimately come back empty.
    print(f"{pad}   {label}: {len(els)} returned, {new} new (total {len(seen)})", flush=True)
    if done is not None:
        done.add(key)
        if tick:
            tick()
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


def load_state():
    """Return (seen, done) from a previous interrupted run, if any."""
    if not STATE.exists():
        return {}, set()
    try:
        blob = json.loads(STATE.read_text())
    except (json.JSONDecodeError, OSError):
        print("checkpoint unreadable; starting fresh", flush=True)
        return {}, set()

    seen = {}
    for k, v in blob.get("seen", {}).items():
        osm_type, osm_id = k.split("/", 1)
        seen[(osm_type, int(osm_id))] = (v[0], v[1], v[2])
    done = set(blob.get("done", []))
    if seen or done:
        print(f"resuming: {len(seen):,} cameras, {len(done):,} cells already done\n", flush=True)
    return seen, done


def save_state(seen, done):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    blob = {
        "seen": {f"{t}/{i}": [lat, lon, tags] for (t, i), (lat, lon, tags) in seen.items()},
        "done": sorted(done),
    }
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(blob, separators=(",", ":")))
    tmp.replace(STATE)


def absorb(els, seen):
    """Fold Overpass elements into `seen`, returning how many were new."""
    new = 0
    for el in els:
        lat, lon = el.get("lat"), el.get("lon")
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
    return new


def try_global(seen):
    """One request for the planet. Returns True if it worked."""
    print(f"asking for the whole planet in one query (up to {GLOBAL_TIMEOUT // 60} min)...", flush=True)
    try:
        els = _run(build_query(None, GLOBAL_TIMEOUT), GLOBAL_TIMEOUT)
    except TooBig as e:
        print(f"  planet-wide query refused ({e}); falling back to the grid walk\n", flush=True)
        return False

    absorb(els, seen)
    print(f"  got {len(seen):,} cameras in one request\n", flush=True)
    return bool(seen)


def main():
    started = time.time()
    seen, done = load_state()

    # The cheap path first; the grid walk exists for when Overpass says no.
    if not seen and try_global(seen):
        write(seen, started)
        STATE.unlink(missing_ok=True)
        return 0

    counter = {"n": 0}

    def tick():
        counter["n"] += 1
        if counter["n"] % FLUSH_EVERY == 0:
            save_state(seen, done)

    # A grid small enough that Overpass accepts most cells without a split.
    cells = []
    lat = -90
    while lat < 90:
        lon = -180
        while lon < 180:
            cells.append((lat, lon, lat + TOP_STEP, lon + TOP_STEP))
            lon += TOP_STEP
        lat += TOP_STEP

    print(f"{len(cells)} top-level cells of {TOP_STEP}deg\n", flush=True)

    try:
        for i, (s_, w_, n_, e_) in enumerate(cells, 1):
            print(f"[{i}/{len(cells)}]", flush=True)
            harvest(s_, w_, n_, e_, seen, 0, done, tick)
    except KeyboardInterrupt:
        save_state(seen, done)
        print("\ninterrupted; progress checkpointed. Re-run to resume.", file=sys.stderr)
        return 130
    except Fatal as e:
        save_state(seen, done)
        print(f"\nfatal: {e}", file=sys.stderr)
        return 1

    if not seen:
        print("ERROR: harvested nothing; refusing to overwrite existing data.", file=sys.stderr)
        return 1

    save_state(seen, done)
    write(seen, started)
    STATE.unlink(missing_ok=True)          # clean finish; next run starts fresh
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
