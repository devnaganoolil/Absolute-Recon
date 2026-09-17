#!/usr/bin/env python3
"""
Harvest recent georeferenced political-violence events from UCDP into one
compact static file.

Source: the Uppsala Conflict Data Program's Georeferenced Event Dataset (GED)
"candidate" release -- UCDP's near-real-time stream, published monthly and
consolidated quarterly.  CC BY 4.0.

Why the static CSVs and not the API: as of 2026 `ucdpapi.pcr.uu.se` requires a
per-user access token, but the release files under ucdp.uu.se/downloads stay
open.  No secret to manage, so the weekly Action needs no configuration.

Two things come out of one pass over the events:

  rows      -- individual events, for the dots on the map
  conflicts -- one entry per conflict, aggregated from those events, for the
               "which wars are running right now" overview

The conflict list is *derived*, not curated.  A conflict appears because UCDP
recorded deadly events in it inside the window, which keeps the layer honest
and self-updating.  The flip side is that a dormant territorial dispute with no
recent casualties -- Taiwan, most of the South China Sea claims -- will not be
in here at all.  That is a property of the source, not a bug to fix downstream.

Output: data/conflicts.json, arrays-of-arrays with interned strings, matching
the shape scripts/harvest.py writes for cameras.
"""

import calendar
import csv
import datetime as dt
import gzip
import io
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "conflicts.json"

BASE = "https://ucdp.uu.se/downloads/candidateged/"

# A published release file never changes -- v26_0_7 is v26_0_7 forever -- so
# downloads are cached and only the newly published one costs anything on a
# re-run. The TTL is purely a hedge against a release being corrected in place.
CACHE = ROOT / "data" / ".ucdp-cache"
CACHE_TTL = 7 * 86400
# A 404 only means "not published yet", so forget those quickly -- otherwise a
# cached miss would hide a release that appeared an hour later.
MISS_TTL = 6 * 3600

UA = "AbsoluteRecon/1.0 (static site data build; +https://github.com/devnaganoolil/Absolute-Recon)"

# How far back to keep events.  UCDP candidate data lags real time by roughly
# two months, so a 24-month window gives ~22 months of usable history and a
# stable picture of which conflicts are actually running.
WINDOW_MONTHS = 24

# UCDP codes each event as one of three kinds of violence.
VIOLENCE = {
    1: "state-based",     # at least one party is a government
    2: "non-state",       # neither party is a government
    3: "one-sided",       # organised violence against unarmed civilians
}

# Politeness delay between downloads, seconds.
DELAY = 1.0
ATTEMPTS = 3
# Longest headline we keep; they are the most useful thing in a popup but also
# the only field with a unique string per event.
HEADLINE_MAX = 140


class Fatal(Exception):
    """A local misconfiguration. Retrying will not help; stop."""


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


def cached(name):
    """Return a cached release's text, or None. '' marks a known-absent file."""
    hit = CACHE / (name + ".csv.gz")
    if hit.exists() and time.time() - hit.stat().st_mtime < CACHE_TTL:
        try:
            return gzip.decompress(hit.read_bytes()).decode("utf-8")
        except (OSError, gzip.BadGzipFile):
            hit.unlink(missing_ok=True)       # truncated by an interrupted run
    miss = CACHE / (name + ".404")
    if miss.exists() and time.time() - miss.stat().st_mtime < MISS_TTL:
        return ""
    return None


def remember(name, text):
    CACHE.mkdir(parents=True, exist_ok=True)
    if text is None:
        (CACHE / (name + ".404")).write_bytes(b"")
    else:
        (CACHE / (name + ".csv.gz")).write_bytes(gzip.compress(text.encode("utf-8"), 6))


def fetch(name, required=False):
    """Download one release CSV. Returns its text, or None if absent."""
    warm = cached(name)
    if warm is not None:
        return warm or None

    url = BASE + name + ".csv"
    last = None
    for attempt in range(ATTEMPTS):
        req = urllib.request.Request(
            url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"}
        )
        try:
            with urllib.request.urlopen(req, timeout=300, context=SSL_CTX) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
            text = raw.decode("utf-8-sig", "replace")
            remember(name, text)
            return text
        except urllib.error.HTTPError as e:
            if e.code == 404:
                remember(name, None)   # that release simply does not exist yet
                return None
            last = f"HTTP {e.code}"
        except urllib.error.URLError as e:
            if isinstance(e.reason, ssl.SSLError):
                raise Fatal(f"TLS failure talking to {url}: {e.reason}")
            last = str(e)
        except Exception as e:
            last = str(e)
        time.sleep(4 * (attempt + 1))

    if required:
        raise Fatal(f"could not download {url}: {last}")
    print(f"  !! giving up on {name}: {last}", flush=True)
    return None


def release_names(today):
    """
    Candidate-release filenames to try, oldest first.

    UCDP publishes the same year under two naming schemes, and neither is a
    strict superset of the other -- the quarterly consolidation both adds
    re-coded events and drops ones the monthly slices had.  So we pull both and
    union by event id, with the quarterly file processed last so its version of
    a shared event wins.

      GEDEvent_v{YY}_0_{N}.csv          monthly slice N of 20YY
      GEDEvent_v{YY}_01_{YY}_{NN}.csv   cumulative through month NN (03/06/09/12)
    """
    start = subtract_months(today, WINDOW_MONTHS)
    names = []
    for year in range(start.year, today.year + 1):
        yy = year % 100
        for n in range(1, 13):
            names.append(f"GEDEvent_v{yy:02d}_0_{n}")
        for nn in (3, 6, 9, 12):
            names.append(f"GEDEvent_v{yy:02d}_01_{yy:02d}_{nn:02d}")
    return names


def subtract_months(d, months):
    """Same day-of-month `months` earlier, clamped to a valid day."""
    total = d.year * 12 + (d.month - 1) - months
    year, month = divmod(total, 12)
    month += 1
    return dt.date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


# UCDP writes "XXX475" where an actor exists in the data but has no public
# name yet. Roughly one conflict in seven in a recent window is one of these,
# and the raw code is meaningless to a reader.
PLACEHOLDER = re.compile(r"\bXXX\d+\b")
UNNAMED = "Unnamed armed group"


def clean_name(value):
    """Swap UCDP's XXXnnn actor placeholders for something readable."""
    if not value:
        return ""
    return PLACEHOLDER.sub(UNNAMED, value.strip())


def display_name(name, countries):
    """
    A conflict label worth showing.

    When both sides are unnamed the cleaned name collapses to "Unnamed armed
    group - Unnamed armed group", which tells a reader nothing.  Fall back to
    the country the fighting is in, which at least locates it.
    """
    name = clean_name(name)
    parts = [p.strip() for p in name.split(" - ")]
    if parts and all(p == UNNAMED for p in parts):
        where = countries[0] if countries else "unknown location"
        return f"Unnamed armed groups ({where})"
    return name


def parse_date(value):
    """UCDP writes '2026-07-11 00:00:00.000'."""
    if not value:
        return None
    try:
        return dt.date.fromisoformat(value[:10])
    except ValueError:
        return None


def to_int(value, default=0):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def collect(today):
    """Union every available release into {event_id: row}, newest naming last."""
    events = {}
    names = release_names(today)
    print(f"trying {len(names)} candidate releases for the last {WINDOW_MONTHS} months\n", flush=True)

    for name in names:
        text = fetch(name)
        if text is None:
            continue
        rows = list(csv.DictReader(io.StringIO(text)))
        before = len(events)
        for row in rows:
            if row.get("id"):
                events[row["id"]] = row
        print(f"  {name}: {len(rows):,} rows, {len(events) - before:,} new "
              f"(total {len(events):,})", flush=True)
        time.sleep(DELAY)

    if not events:
        raise Fatal("no UCDP releases could be downloaded")
    return events


def build(events, today):
    """Turn raw UCDP rows into the payload the site loads."""
    cutoff = subtract_months(today, WINDOW_MONTHS)
    epoch = dt.date(1970, 1, 1)

    # Pass 1: keep the events inside the window, and total them up per conflict.
    # Conflict name, belligerents and violence type are properties of the
    # conflict rather than the event, so they live in `conflicts` and each row
    # just points at its entry -- cheaper than repeating them 51,000 times, and
    # it gives an event popup the whole conflict's context for free.
    kept = []
    agg = {}
    skipped = {"no_geo": 0, "no_date": 0, "too_old": 0}

    for row in events.values():
        date = parse_date(row.get("date_start"))
        if date is None:
            skipped["no_date"] += 1
            continue
        if date < cutoff:
            skipped["too_old"] += 1
            continue

        try:
            lat = float(row["latitude"])
            lon = float(row["longitude"])
        except (KeyError, TypeError, ValueError):
            skipped["no_geo"] += 1
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            skipped["no_geo"] += 1
            continue

        tov = to_int(row.get("type_of_violence"), 1)
        deaths = to_int(row.get("best"))
        civilians = to_int(row.get("deaths_civilians"))
        conflict_id = row.get("conflict_new_id") or ""
        kept.append((row, date, lat, lon, tov, deaths, civilians, conflict_id))

        a = agg.setdefault(conflict_id, {
            "name": row.get("conflict_name") or "",
            "side_a": row.get("side_a") or "",
            "side_b": row.get("side_b") or "",
            # Usually one value for the whole conflict, but ~5% of them mix
            # (a war whose events include massacres of civilians), so the
            # conflict carries the dominant type and each event keeps its own.
            "tov": {},
            "events": 0,
            "deaths": 0,
            "civilians": 0,
            "lat_sum": 0.0,
            "lon_sum": 0.0,
            "weight": 0.0,
            "first": date,
            "last": date,
            "countries": {},
        })
        a["events"] += 1
        a["tov"][tov] = a["tov"].get(tov, 0) + 1
        a["deaths"] += deaths
        a["civilians"] += civilians
        # Weight the centroid by deaths so a conflict's marker lands where the
        # fighting actually is, not at the mean of every reported skirmish.
        # +1 keeps zero-casualty events contributing something.
        w = deaths + 1
        a["lat_sum"] += lat * w
        a["lon_sum"] += lon * w
        a["weight"] += w
        a["first"] = min(a["first"], date)
        a["last"] = max(a["last"], date)
        country = row.get("country") or ""
        if country:
            a["countries"][country] = a["countries"].get(country, 0) + 1

    # Heaviest first, so the overview layer draws the big wars on top and a
    # truncated list is still the list that matters.
    order = sorted(agg, key=lambda k: -agg[k]["deaths"])
    slot = {conflict_id: i for i, conflict_id in enumerate(order)}

    conflicts = []
    for conflict_id in order:
        a = agg[conflict_id]
        countries = sorted(a["countries"], key=a["countries"].get, reverse=True)
        conflicts.append({
            "id": to_int(conflict_id, -1),
            "name": display_name(a["name"], countries),
            "sideA": clean_name(a["side_a"]),
            "sideB": clean_name(a["side_b"]),
            "tov": max(a["tov"], key=a["tov"].get),
            "lat": round(a["lat_sum"] / a["weight"], 4),
            "lon": round(a["lon_sum"] / a["weight"], 4),
            "events": a["events"],
            "deaths": a["deaths"],
            "civilians": a["civilians"],
            "first": a["first"].isoformat(),
            "last": a["last"].isoformat(),
            "countries": countries[:4],
        })

    # Pass 2: emit the events themselves.
    pools = {"country": [], "adm1": [], "headline": []}
    index = {k: {} for k in pools}

    def intern(pool, value):
        if not value:
            return -1
        value = str(value).strip()
        if not value:
            return -1
        value = value[:HEADLINE_MAX if pool == "headline" else 90]
        if value not in index[pool]:
            index[pool][value] = len(pools[pool])
            pools[pool].append(value)
        return index[pool][value]

    rows = []
    for row, date, lat, lon, tov, deaths, civilians, conflict_id in kept:
        rows.append([
            round(lat, 4),
            round(lon, 4),
            (date - epoch).days,
            tov,
            slot[conflict_id],
            intern("country", row.get("country")),
            intern("adm1", row.get("adm_1")),
            deaths,
            civilians,
            # where_prec 1-2 is an exact or nearby point; 4+ is province-level
            # or worse, and 6 is no better than "somewhere in this country".
            # The site draws those hollow instead of implying precision.
            to_int(row.get("where_prec"), 7),
            intern("headline", row.get("source_headline")),
            to_int(row.get("id"), -1),
        ])

    # Sort north-to-south so gzip sees runs of similar latitudes, as with cameras.
    rows.sort(key=lambda r: (-r[0], r[1]))

    payload = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "UCDP Georeferenced Event Dataset (candidate release), CC BY 4.0",
        "sourceUrl": "https://ucdp.uu.se/downloads/",
        "windowMonths": WINDOW_MONTHS,
        "windowStart": cutoff.isoformat(),
        "count": len(rows),
        "violence": VIOLENCE,
        "fields": [
            "lat", "lon", "day", "tov", "conflict",
            "country", "adm1", "deaths", "civilians", "wherePrec",
            "headline", "ucdpId",
        ],
        "epoch": "1970-01-01",
        "pools": pools,
        "conflicts": conflicts,
        "rows": rows,
    }

    print(
        f"\nkept {len(rows):,} events in {len(conflicts):,} conflicts since {cutoff}"
        f"\nskipped: {skipped['too_old']:,} older than the window, "
        f"{skipped['no_geo']:,} without usable coordinates, "
        f"{skipped['no_date']:,} without a date",
        flush=True,
    )
    return payload


def write(payload, started=None):
    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    tmp.replace(OUT)

    raw = OUT.stat().st_size
    packed = len(gzip.compress(OUT.read_bytes(), 9))
    took = f", in {(time.time() - started) / 60:.1f} min" if started else ""
    print(
        f"Wrote {OUT.relative_to(ROOT)}: {payload['count']:,} events, "
        f"{raw/1e6:.1f} MB raw / {packed/1e6:.1f} MB gzipped{took}"
    )


def main():
    started = time.time()
    today = dt.date.today()
    try:
        payload = build(collect(today), today)
    except Fatal as e:
        print(f"\nfatal: {e}", file=sys.stderr)
        return 1

    if not payload["count"]:
        print("ERROR: harvested no events; refusing to overwrite existing data.",
              file=sys.stderr)
        return 1

    write(payload, started)

    top = payload["conflicts"][:8]
    if top:
        print("\nheaviest conflicts in the window:")
        width = max(len(c["name"]) for c in top)
        for c in top:
            print(f"  {c['name']:<{width}}  {c['deaths']:>7,} deaths  "
                  f"{c['events']:>5,} events")
    return 0


if __name__ == "__main__":
    sys.exit(main())
