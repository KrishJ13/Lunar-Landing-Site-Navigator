"""Independent comparison against JPL Horizons (https://ssd-api.jpl.nasa.gov/api/horizons.api).

Observer: CENTER='coord@301' (user-defined surface site on the Moon), COORD_TYPE='CYLINDRICAL',
SITE_COORD='lon_east_deg,dxy_km,dz_km' with dxy = R cos(lat), dz = R sin(lat), R = 1737.4 km
+ h. Cylindrical is used because it is planetocentric (GEODETIC would apply Horizons' own
ellipsoid/geodetic latitude). QUANTITIES 4 = apparent azimuth/elevation (APPARENT=AIRLESS, no refraction),
20 = range (observer->target, au). Only network access to ssd.jpl.nasa.gov is required.

Usage: python scripts/horizons_compare.py LAT LON_EAST ELEV_M T1 [T2 ...]
Prints a residual table (lunar_sky minus Horizons) and writes JSON when --json is given.
"""
import argparse
import csv
import io
import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import math
from lunar_sky.positions import REFERENCE_RADIUS_KM, calculate_positions

API = "https://ssd.jpl.nasa.gov/api/horizons.api"
AU_KM = 149597870.7
BODIES = {"sun": "10", "earth": "399"}


def query(command, lat, lon, h_m, times):
    r = REFERENCE_RADIUS_KM + h_m / 1000.0
    la = math.radians(lat)
    params = {
        "format": "text", "COMMAND": f"'{command}'", "OBJ_DATA": "'NO'", "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'OBSERVER'", "CENTER": "'coord@301'", "COORD_TYPE": "'CYLINDRICAL'",
        "SITE_COORD": f"'{lon % 360.0:.10f},{r*math.cos(la):.10f},{r*math.sin(la):.10f}'",
        "TLIST": " ".join(times), "TLIST_TYPE": "JD", "TIME_TYPE": "UT",
        "QUANTITIES": "'4,20'", "ANG_FORMAT": "'DEG'", "APPARENT": "'AIRLESS'",
        "CSV_FORMAT": "'YES'", "EXTRA_PREC": "'YES'",
    }
    url = API + "?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:
            text = resp.read().decode()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Horizons HTTP {e.code}: {e.read().decode()[:1500]}") from None
    m = re.search(r"\$\$SOE\n(.*?)\n\$\$EOE", text, re.S)
    if not m:
        raise RuntimeError("Horizons returned no ephemeris:\n" + text[:1500])
    rows = list(csv.reader(io.StringIO(m.group(1))))
    return text, [(float(r[3]), float(r[4]), float(r[5]) * AU_KM) for r in rows]  # az, el, range km


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("lat", type=float)
    ap.add_argument("lon", type=float)
    ap.add_argument("elev_m", type=float)
    ap.add_argument("times", nargs="+", help="UTC, e.g. 2027-03-14T12:00:00Z")
    ap.add_argument("--json")
    a = ap.parse_args()
    # JD(UT) from UTC; Horizons TIME_TYPE=UT is UTC for modern epochs.
    hz_times = [f"{datetime.fromisoformat(t).astimezone(timezone.utc).timestamp() / 86400 + 2440587.5:.8f}"
                for t in a.times]
    out = []
    print(f"{'body':6} {'time (UTC)':20} {'dAz (arcsec)':>13} {'dEl (arcsec)':>13} {'dRange (km)':>13}")
    for body, cmd in BODIES.items():
        _, hz = query(cmd, a.lat, a.lon, a.elev_m, hz_times)
        for t, (haz, hel, hr) in zip(a.times, hz):
            mine = calculate_positions(a.lat, a.lon, a.elev_m, t)[body]
            daz = (mine["azimuth_deg"] - haz + 180.0) % 360.0 - 180.0
            rec = {"body": body, "time": t, "lunar_sky": mine,
                   "horizons": {"azimuth_deg": haz, "elevation_deg": hel, "distance_km": hr},
                   "d_az_arcsec": daz * 3600, "d_el_arcsec": (mine["elevation_deg"] - hel) * 3600,
                   "d_range_km": mine["distance_km"] - hr}
            out.append(rec)
            print(f"{body:6} {t:20} {rec['d_az_arcsec']:13.3f} {rec['d_el_arcsec']:13.3f} {rec['d_range_km']:13.4f}")
    if a.json:
        # Configuration (what was asked) is stored apart from evidence (what came back).
        doc = {"configuration": {"api": API, "center": "coord@301", "coord_type": "CYLINDRICAL",
                                 "site": {"lat_deg": a.lat, "lon_east_deg": a.lon, "elev_m": a.elev_m,
                                          "reference_radius_km": REFERENCE_RADIUS_KM},
                                 "quantities": "4,20", "apparent": "AIRLESS", "time_type": "UT",
                                 "ours": "spkcpo LT+S MOON_ME_DE440_ME421, kernels per kernels_manifest.json"},
               "retrieved_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "evidence": out}
        Path(a.json).write_text(json.dumps(doc, indent=2))


if __name__ == "__main__":
    main()
