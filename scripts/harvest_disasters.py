#!/usr/bin/env python3
"""
Harvest current natural-disaster activity from three complementary feeds into
one compact static file.

No single source covers the field, so this merges:

  USGS   earthquake.usgs.gov  -- every quake M4.0+ in the window.
                                 Authoritative and near-real-time; nothing else
                                 comes close for seismicity.
  EONET  NASA's Earth Observatory Natural Event Tracker -- wildfires,
                                 volcanoes, severe storms, ice, dust.  Satellite
                                 derived, so it sees fires nobody has reported.
                                 Its `earthquakes` and `floods` categories exist
                                 in the API but sit empty in practice, which is
                                 why the other two feeds are here.
  GDACS  the EU/UN Global Disaster Alert and Coordination System -- the Orange
                                 and Red alerts only.  This is the one source
                                 that scores *humanitarian* impact (population
                                 exposed, alert level) and the only one that
                                 covers floods, cyclones and drought properly.

All three are keyless, and all three send `Access-Control-Allow-Origin: *`, so
the site could refresh them live in the browser.  It deliberately does not:
normalising three unrelated schemas into one shape is most of this file, and
doing it again in JavaScript would mean two copies of the same category mapping,
free to drift apart.  The Action re-runs every three hours instead, which is
fresh enough for a map whose shortest-lived hazard is a wildfire.

Output: data/disasters.json.  Small enough (a few hundred KB) that it ships as
plain GeoJSON-ish records rather than the interned arrays cameras.json uses.
"""

import datetime as dt
import gzip
import json
import math
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "disasters.json"

UA = "AbsoluteRecon/1.0 (static site data build; +https://github.com/devnaganoolil/Absolute-Recon)"

USGS = "https://earthquake.usgs.gov/fdsnws/event/1/query"
EONET = "https://eonet.gsfc.nasa.gov/api/v3/events"
GDACS = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH"

# How much history to keep. Long enough to show a season's wildfires, short
# enough that the file stays small and "current" means something.
#
# The rule everywhere below is: keep an event when its most recent observation
# falls inside this window. Two kinds are exempt, because both EONET and GDACS
# model them as a single long-lived event that is only touched when the
# situation changes -- an erupting volcano or a running drought can be entirely
# current with its last update months old. Those are kept while the source
# still lists them as active, and the popup shows when they were last seen so
# nobody has to guess.
WINDOW_DAYS = 60
LONG_LIVED = {"volcano", "drought"}

# The categories the site groups everything into, and what they are called.
KINDS = {
    "quake":    "Earthquakes",
    "volcano":  "Volcanoes",
    "wildfire": "Wildfires",
    "storm":    "Storms and cyclones",
    "flood":    "Floods",
    "drought":  "Drought",
    "other":    "Other hazards",
}

# EONET category id -> our kind.
EONET_KINDS = {
    "wildfires": "wildfire",
    "volcanoes": "volcano",
    "severeStorms": "storm",
    "floods": "flood",
    "drought": "drought",
    "earthquakes": "quake",
    "landslides": "other",
    "snow": "other",
    "dustHaze": "other",
    "tempExtremes": "other",
    "seaLakeIce": "other",
    "waterColor": "other",
    "manmade": "other",
}

# GDACS event type -> our kind.
GDACS_KINDS = {
    "EQ": "quake",
    "TC": "storm",
    "FL": "flood",
    "VO": "volcano",
    "DR": "drought",
    "WF": "wildfire",
    "TS": "other",      # tsunami
}

# Smallest earthquake worth a marker. The ready-made USGS summary feeds stop
# at 30 days, so this goes through the FDSN query API to cover the same window
# as everything else. M4.0 keeps it to quakes a person could feel -- M2.5+ is
# 4,900 events in 60 days, almost all of them instrument-only, and they bury
# every other hazard on the map.
MIN_MAGNITUDE = 4.0

ATTEMPTS = 3
# A GDACS earthquake this close in space and time to a USGS one is the same
# event. GDACS rounds its epicentres, hence the generous radius.
DEDUPE_KM = 120
DEDUPE_HOURS = 24


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


def get_json(url, label):
    """Fetch and parse one feed. Returns None rather than raising."""
    last = None
    for attempt in range(ATTEMPTS):
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": UA,
                "Accept": "application/json",
                "Accept-Encoding": "gzip",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=120, context=SSL_CTX) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
            return json.loads(raw.decode("utf-8", "replace"))
        except urllib.error.URLError as e:
            if isinstance(getattr(e, "reason", None), ssl.SSLError):
                raise Fatal(f"TLS failure talking to {url}: {e.reason}")
            last = str(e)
        except Exception as e:
            last = str(e)
        time.sleep(3 * (attempt + 1))

    print(f"  !! {label} unavailable: {last}", flush=True)
    return None


def iso_day(value):
    """Normalise whatever a feed gives us to a plain YYYY-MM-DD."""
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(
            str(value).replace("Z", "+00:00")
        ).date().isoformat()
    except ValueError:
        return str(value)[:10] or None


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def from_usgs(cutoff, today):
    """Earthquakes from the USGS FDSN event service."""
    url = f"{USGS}?" + urllib.parse.urlencode({
        "format": "geojson",
        "starttime": cutoff.isoformat(),
        "endtime": (today + dt.timedelta(days=1)).isoformat(),
        "minmagnitude": MIN_MAGNITUDE,
        "orderby": "time",
    })
    data = get_json(url, "USGS earthquakes")
    if not data:
        return []

    out = []
    for f in data.get("features") or []:
        p = f.get("properties") or {}
        geom = (f.get("geometry") or {}).get("coordinates") or []
        if len(geom) < 2 or geom[0] is None or geom[1] is None:
            continue
        when = p.get("time")
        if not when:
            continue
        moment = dt.datetime.fromtimestamp(when / 1000, dt.timezone.utc)
        if moment.date() < cutoff:
            continue

        mag = p.get("mag")
        out.append({
            "id": "usgs:" + str(f.get("id")),
            "kind": "quake",
            "title": p.get("title") or "Earthquake",
            "lat": round(float(geom[1]), 4),
            "lon": round(float(geom[0]), 4),
            "date": moment.date().isoformat(),
            "time": moment.replace(microsecond=0).isoformat(),
            "mag": round(float(mag), 1) if mag is not None else None,
            "magUnit": "M",
            "depthKm": round(float(geom[2]), 1) if len(geom) > 2 and geom[2] is not None else None,
            "place": p.get("place") or "",
            # USGS ShakeMap alert, when one was issued: green/yellow/orange/red.
            "alert": p.get("alert") or None,
            "tsunami": bool(p.get("tsunami")),
            "url": p.get("url") or "",
            "src": "USGS",
        })

    print(f"  USGS: {len(out):,} earthquakes M{MIN_MAGNITUDE:g}+ in the window",
          flush=True)
    return out


def from_eonet(cutoff, today):
    """
    Wildfires, volcanoes and storms from NASA EONET.

    Two queries, unioned by event id, because neither alone is enough:

      start/end   recent activity, but it drops anything that *began* before the
                  window -- which is most volcanoes, since EONET treats an
                  erupting volcano as one long-lived open event.
      status=open everything still running, whenever it started.

    An EONET event is a track: one geometry per observation.  We take the most
    recent point as the position and count the rest, because a hurricane's
    current location is the useful one and its history is just context.
    """
    windowed = f"{EONET}?" + urllib.parse.urlencode({
        "start": cutoff.isoformat(),
        "end": today.isoformat(),
        "limit": 3000,
    })
    ongoing = f"{EONET}?" + urllib.parse.urlencode({"status": "open", "limit": 3000})

    merged = {}
    for url, label in ((windowed, "NASA EONET (window)"),
                       (ongoing, "NASA EONET (open)")):
        data = get_json(url, label)
        for e in (data or {}).get("events") or []:
            if e.get("id"):
                merged.setdefault(e["id"], e)
    if not merged:
        return []

    out = []
    for e in merged.values():
        geoms = [g for g in (e.get("geometry") or []) if g.get("coordinates")]
        if not geoms:
            continue
        geoms.sort(key=lambda g: g.get("date") or "")
        latest = geoms[-1]

        coords = latest["coordinates"]
        # A track point is [lon, lat]; a polygon footprint nests deeper, so
        # fall back to its first vertex rather than dropping the event.
        while isinstance(coords, list) and coords and isinstance(coords[0], list):
            coords = coords[0]
        if len(coords) < 2:
            continue

        cats = e.get("categories") or []
        kind = "other"
        for c in cats:
            if c.get("id") in EONET_KINDS:
                kind = EONET_KINDS[c["id"]]
                break

        seen_at = iso_day(latest.get("date"))
        closed = iso_day(e.get("closed"))
        # `status=open` hands back wildfires EONET opened and never closed, so
        # the last observation is what decides whether this is current.
        if seen_at and seen_at < cutoff.isoformat():
            if kind not in LONG_LIVED or closed:
                continue

        mag = latest.get("magnitudeValue")
        out.append({
            "id": "eonet:" + str(e.get("id")),
            "kind": kind,
            "title": e.get("title") or "Natural event",
            "lat": round(float(coords[1]), 4),
            "lon": round(float(coords[0]), 4),
            "date": seen_at,
            "started": iso_day(geoms[0].get("date")),
            "closed": closed,
            "mag": round(float(mag), 1) if mag is not None else None,
            "magUnit": latest.get("magnitudeUnit") or "",
            "track": len(geoms),
            "place": (cats[0].get("title") if cats else "") or "",
            "url": (e.get("sources") or [{}])[0].get("url") or e.get("link") or "",
            "src": "NASA EONET",
        })

    print(f"  NASA EONET: {len(out):,} events in the window", flush=True)
    return out


def from_gdacs(cutoff):
    """
    Significant disasters from GDACS -- the Orange and Red alerts.

    The bare SEARCH endpoint returns exactly that set.  Passing an explicit
    alertlevel or date range instead returns the Green-alert firehose capped at
    100 records, which is both noisier and less complete, so we do not.
    """
    data = get_json(GDACS, "GDACS alerts")
    if not data:
        return []

    out = []
    for f in data.get("features") or []:
        p = f.get("properties") or {}
        geom = (f.get("geometry") or {}).get("coordinates") or []
        if len(geom) < 2 or geom[0] is None or geom[1] is None:
            continue

        severity = p.get("severitydata") or {}
        kind = GDACS_KINDS.get(p.get("eventtype"), "other")

        # Judge currency by when the episode *ended*, not when it began: a
        # flood or cyclone can run for weeks and still be live. Explicitly not
        # `datemodified` -- GDACS re-touches old records, and using that let a
        # three-month-old earthquake through as though it had just happened.
        date = iso_day(p.get("fromdate"))
        ended = iso_day(p.get("todate"))
        fresh = ended or date
        if fresh and fresh < cutoff.isoformat() and kind not in LONG_LIVED:
            continue
        alert = (p.get("alertlevel") or "").lower() or None
        countries = ", ".join(
            c.get("countryname", "") for c in (p.get("affectedcountries") or [])
            if c.get("countryname")
        )

        # GDACS reports severity 0 / "Magnitude 0" for hazards it does not
        # actually score that way -- most floods and droughts. Printing that in
        # a popup is worse than printing nothing, so drop it.
        magnitude = severity.get("severity")
        if not magnitude:
            magnitude, severity_text = None, ""
        else:
            severity_text = " ".join((severity.get("severitytext") or "").split())

        out.append({
            "id": f"gdacs:{p.get('eventtype')}{p.get('eventid')}",
            "kind": kind,
            # GDACS names arrive with doubled spaces ("Eruption  Semeru").
            "title": " ".join((p.get("name") or p.get("description")
                               or "Disaster alert").split()),
            "lat": round(float(geom[1]), 4),
            "lon": round(float(geom[0]), 4),
            "date": date,
            "ended": ended,
            "mag": magnitude,
            "magUnit": severity.get("severityunit") or "",
            "severityText": severity_text,
            "alert": alert,
            "place": countries or p.get("country") or "",
            "url": (p.get("url") or {}).get("report") or "",
            "src": "GDACS",
        })

    print(f"  GDACS: {len(out):,} orange/red alerts in the window", flush=True)
    return out


# How an alert level maps onto the 0-1 significance scale, for the hazards
# whose own magnitude is not a number you can rank across sources.
ALERT_WEIGHT = {"red": 0.95, "orange": 0.7, "yellow": 0.5, "green": 0.35}


def weigh(event):
    """
    One comparable 0-1 "how big is this" number.

    `mag` cannot do this job: it is a Richter magnitude for USGS, km/h for a
    GDACS cyclone and km^2 of affected land for a drought. Interpolating icon
    size straight off it made every drought and storm max out. So each kind is
    normalised on its own scale, and hazards with no meaningful magnitude fall
    back to the alert level.
    """
    kind, mag = event["kind"], event.get("mag")

    if kind == "quake" and mag:
        return clamp((mag - 4.0) / 4.0)          # M4 -> 0, M8 -> 1
    if kind == "storm" and mag:
        return clamp((mag - 60.0) / 190.0)       # 60 km/h -> 0, 250 -> 1
    if kind == "volcano" and mag:
        return clamp(mag / 6.0)                  # VEI-ish, when present

    weight = ALERT_WEIGHT.get(event.get("alert") or "")
    if weight is not None:
        return weight
    # Nothing to go on: a satellite-detected wildfire with no alert level.
    return 0.4


def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def dedupe_quakes(usgs, others):
    """
    Drop GDACS earthquakes that USGS already has.

    Both feeds carry the big ones, and two markers a few pixels apart for the
    same earthquake reads as a data bug.  USGS wins on position and magnitude;
    the GDACS alert level it would have contributed is a fair thing to lose,
    since USGS publishes its own for anything that size.
    """
    quakes = [e for e in usgs if e["kind"] == "quake" and e.get("date")]
    kept, dropped = [], 0

    for e in others:
        if e["kind"] != "quake" or not e.get("date"):
            kept.append(e)
            continue
        here = dt.date.fromisoformat(e["date"])
        match = any(
            abs((dt.date.fromisoformat(q["date"]) - here).days) * 24 <= DEDUPE_HOURS
            and haversine_km(e["lat"], e["lon"], q["lat"], q["lon"]) <= DEDUPE_KM
            for q in quakes
        )
        if match:
            dropped += 1
        else:
            kept.append(e)

    if dropped:
        print(f"  deduped {dropped} GDACS earthquake(s) already in the USGS feed",
              flush=True)
    return kept


def main():
    started = time.time()
    today = dt.date.today()
    cutoff = today - dt.timedelta(days=WINDOW_DAYS)

    print(f"harvesting natural disasters since {cutoff} "
          f"({WINDOW_DAYS}-day window)\n", flush=True)

    try:
        usgs = from_usgs(cutoff, today)
        eonet = from_eonet(cutoff, today)
        gdacs = from_gdacs(cutoff)
    except Fatal as e:
        print(f"\nfatal: {e}", file=sys.stderr)
        return 1

    events = usgs + dedupe_quakes(usgs, eonet + gdacs)
    if not events:
        print("ERROR: every feed failed; refusing to overwrite existing data.",
              file=sys.stderr)
        return 1

    for e in events:
        e["weight"] = round(weigh(e), 3)
        # Every title gets its whitespace collapsed, not just GDACS's -- a
        # doubled space shows up in EONET names too.
        e["title"] = " ".join(str(e.get("title") or "").split())

    # Most severe first so the map draws the things that matter on top.
    rank = {"red": 0, "orange": 1, "yellow": 2, "green": 3}
    events.sort(key=lambda e: (
        rank.get(e.get("alert") or "", 4),
        -e["weight"],
    ))

    counts = {}
    for e in events:
        counts[e["kind"]] = counts.get(e["kind"], 0) + 1

    payload = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "windowDays": WINDOW_DAYS,
        "windowStart": cutoff.isoformat(),
        "count": len(events),
        "kinds": KINDS,
        "counts": counts,
        "sources": [
            {"id": "USGS", "name": "USGS Earthquake Hazards Program",
             "url": "https://earthquake.usgs.gov/",
             "note": f"earthquakes M{MIN_MAGNITUDE:g}+, public domain"},
            {"id": "NASA EONET", "name": "NASA Earth Observatory Natural Event Tracker",
             "url": "https://eonet.gsfc.nasa.gov/",
             "note": "wildfires, volcanoes, storms, ice"},
            {"id": "GDACS", "name": "Global Disaster Alert and Coordination System",
             "url": "https://www.gdacs.org/",
             "note": "orange/red humanitarian alerts, © European Union"},
        ],
        "events": events,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    tmp.replace(OUT)

    raw = OUT.stat().st_size
    packed = len(gzip.compress(OUT.read_bytes(), 9))
    print(
        f"\nWrote {OUT.relative_to(ROOT)}: {len(events):,} events, "
        f"{raw/1e3:.0f} kB raw / {packed/1e3:.0f} kB gzipped, "
        f"in {time.time() - started:.0f}s"
    )
    for kind, label in KINDS.items():
        if counts.get(kind):
            print(f"  {label:<20} {counts[kind]:>5,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
