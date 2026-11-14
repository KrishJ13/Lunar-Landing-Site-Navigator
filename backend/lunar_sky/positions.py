"""Apparent Sun/Earth position for an observer on the lunar surface.

Method (SPICE ``spkcpo``; argument semantics checked against spkcpo_c docs):
  target   = "SUN" / "EARTH" (body centres, DE440s)
  obspos   = (R+h) * unit(lat, lon) in the Moon-fixed frame; a position *relative to obsctr*
  obsctr   = "MOON"                (obspos is measured from the Moon's centre)
  obsref   = MOON_ME_DE440_ME421   (frame in which obspos is expressed; rotates with the Moon)
  outref   = MOON_ME_DE440_ME421   (output frame; fixed rotation away from the local ENU frame)
  refloc   = "OBSERVER"            (outref evaluated at the observation epoch et, i.e. the frame
                                    the observer stands in at reception; "TARGET" would evaluate
                                    it at et - lt, which is wrong for a surface observer)
  abcorr   = "LT+S"                (reception geometry: one-way light time + stellar aberration;
                                    observer velocity includes the Moon-fixed frame's rotation)
The returned vector is rotated into the local east/north/up (ENU) basis built from
planetocentric latitude and east-positive longitude.

Conventions
  * latitude: planetocentric, degrees, [-90, 90]; longitude: east-positive, degrees,
    [-360, 360] (normalised to [0, 360)); elevation_m: metres above the 1737.4 km sphere.
  * azimuth: clockwise from local north, [0, 360); elevation: angle above the local
    mathematical horizon (plane normal to the sphere's radial "up"), [-90, 90].
  * East  = (-sin lon, cos lon, 0)
    North = (-sin lat cos lon, -sin lat sin lon, cos lat)
    Up    = (cos lat cos lon, cos lat sin lon, sin lat)
  * Exact poles (|lat| = 90): north/east are undefined. This module takes the limit along the
    meridian of the supplied longitude, i.e. the formulas above are used unchanged. At the south
    pole North points toward the meridian at `longitude`; at the north pole it points away from
    it (toward longitude+180). Azimuth at a pole is therefore relative to the supplied longitude
    and only meaningful together with it. Elevation does not depend on this convention.
  * Elevation is the MATHEMATICAL horizon only: no terrain, no refraction (airless body), no
    limb correction. It refers to the body centre, not the upper limb.
"""
import json
import math
from datetime import timezone, datetime

import numpy as np
import spiceypy as sp

from .kernels import MOON_FRAME, ROOT, load_kernels

REFERENCE_RADIUS_KM = 1737.4
ABCORR = "LT+S"
# Physical radii used for angular size (documented constants, not read from kernels):
#   Sun   695700 km  (IAU 2015 Resolution B3 nominal solar radius)
#   Earth 6371.0 km  (mean radius; equatorial 6378.137 km differs by 0.1 %)
BODY_RADIUS_KM = {"sun": 695700.0, "earth": 6371.0}
_TARGETS = {"sun": "SUN", "earth": "EARTH"}
H_MIN_M, H_MAX_M = -10000.0, 20000.0


def enu_basis(latitude_deg, longitude_deg_east):
    """3x3 matrix whose rows are unit east, north, up in the Moon-fixed frame."""
    la, lo = math.radians(latitude_deg), math.radians(longitude_deg_east)
    sla, cla, slo, clo = math.sin(la), math.cos(la), math.sin(lo), math.cos(lo)
    return np.array([[-slo, clo, 0.0],
                     [-sla * clo, -sla * slo, cla],
                     [cla * clo, cla * slo, sla]])


def observer_position_km(latitude_deg, longitude_deg_east, elevation_m):
    up = enu_basis(latitude_deg, longitude_deg_east)[2]
    return (REFERENCE_RADIUS_KM + elevation_m / 1000.0) * up


def _validate(lat, lon, h, ts):
    for name, v in (("latitude_deg", lat), ("longitude_deg_east", lon), ("elevation_m", h)):
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            raise ValueError(f"{name} must be a finite number, got {v!r}")
    if not -90.0 <= lat <= 90.0:
        raise ValueError(f"latitude_deg must be in [-90, 90], got {lat}")
    if not -360.0 <= lon <= 360.0:
        raise ValueError(f"longitude_deg_east must be in [-360, 360], got {lon}")
    if not H_MIN_M <= h <= H_MAX_M:
        raise ValueError(f"elevation_m must be in [{H_MIN_M}, {H_MAX_M}], got {h}")
    if not isinstance(ts, str):
        raise ValueError("timestamp_utc must be an ISO 8601 string")
    try:
        dt = datetime.fromisoformat(ts.strip())
    except ValueError as e:
        raise ValueError(f"unparseable timestamp_utc {ts!r}: {e}") from None
    if dt.tzinfo is None or dt.utcoffset().total_seconds() != 0:
        raise ValueError("timestamp_utc must be explicitly UTC (suffix 'Z' or '+00:00')")
    return dt.astimezone(timezone.utc)


def calculate_positions(latitude_deg, longitude_deg_east, elevation_m, timestamp_utc):
    dt = _validate(latitude_deg, longitude_deg_east, elevation_m, timestamp_utc)
    lon = longitude_deg_east % 360.0
    if sp.ktotal("ALL") == 0:
        load_kernels()
    try:
        et = sp.str2et(dt.strftime("%Y-%m-%dT%H:%M:%S.%f"))
        obspos = observer_position_km(latitude_deg, lon, elevation_m)
        enu = enu_basis(latitude_deg, lon)
        out = {}
        for key, target in _TARGETS.items():
            state, _lt = sp.spkcpo(target, et, MOON_FRAME, "OBSERVER", ABCORR,
                                   list(obspos), "MOON", MOON_FRAME)
            e, n, u = enu @ np.asarray(state[:3])
            dist = float(np.linalg.norm([e, n, u]))
            out[key] = {
                "azimuth_deg": float(math.degrees(math.atan2(e, n)) % 360.0),
                "elevation_deg": float(math.degrees(math.atan2(u, math.hypot(e, n)))),
                "distance_km": dist,
                "angular_radius_deg": float(math.degrees(math.asin(BODY_RADIUS_KM[key] / dist))),
            }
    except sp.SpiceyError as e:
        raise ValueError(f"SPICE could not evaluate this request (kernel coverage?): {e}") from None
    manifest = json.loads((ROOT / "kernels_manifest.json").read_text())
    return {
        "site": {"latitude_deg": latitude_deg, "longitude_deg_east": longitude_deg_east,
                 "elevation_m": elevation_m},
        "timestamp_utc": timestamp_utc,
        "sun": out["sun"],
        "earth": out["earth"],
        "model": {
            "reference_frame": MOON_FRAME,
            "reference_radius_km": REFERENCE_RADIUS_KM,
            "aberration_correction": ABCORR,
            "spice_function": "spkcpo(obsctr=MOON, obsref=outref=MOON_ME_DE440_ME421, refloc=OBSERVER)",
            "body_radii_km": BODY_RADIUS_KM,
            "kernel_manifest": "backend/kernels_manifest.json",
            "kernels": [k["filename"] for k in manifest["kernels"]],
            "terrain_occlusion_modelled": False,
            "horizon": "mathematical (no terrain, no refraction)",
            "validation_status": "pending",
        },
    }
