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
import re
from datetime import timedelta, timezone, datetime

import numpy as np
import spiceypy as sp

from .kernels import MOON_FRAME, ROOT, et_to_utc, load_kernels, pck_coverage_et, spk_coverage_et

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
        s = ts.strip()
        # Python 3.10's fromisoformat rejects a trailing 'Z' and fractional
        # seconds that are not 3 or 6 digits (3.11+ accepts both).
        if s[-1:] in ("Z", "z"):
            s = s[:-1] + "+00:00"
        s = re.sub(r"(\d{2}:\d{2}:\d{2})\.(\d{1,6})", lambda m: f"{m[1]}.{m[2].ljust(6, '0')}", s)
        dt = datetime.fromisoformat(s)
    except ValueError as e:
        raise ValueError(f"unparseable timestamp_utc {ts!r}: {e}") from None
    if dt.tzinfo is None or dt.utcoffset().total_seconds() != 0:
        raise ValueError("timestamp_utc must be explicitly UTC (suffix 'Z' or '+00:00')")
    return dt.astimezone(timezone.utc)


def _site(latitude_deg, longitude_deg_east, elevation_m):
    """Constant per-site geometry (observer position, ENU basis), computed once per request."""
    lon = longitude_deg_east % 360.0
    return observer_position_km(latitude_deg, lon, elevation_m), enu_basis(latitude_deg, lon)


def _et(dt):
    return sp.str2et(dt.strftime("%Y-%m-%dT%H:%M:%S.%f"))


def _evaluate(et, obspos, enu):
    """Apparent Sun/Earth for one epoch. Caller must hold the SPICE lock and have kernels loaded."""
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
    return out


ILLUMINATION_MAX_SAMPLES = 10000  # e.g. 3 months at 15 min
ILLUMINATION_MAX_HOURS = 24 * 400  # about 13 lunar days


def body_series(latitude_deg, longitude_deg_east, elevation_m, start_utc, hours, step_minutes):
    """Apparent Sun and Earth for the observer at the site, every step from start_utc for `hours`
    (t_k = start + k step, k = 0..floor(hours*60/step)), evaluated as calculate_positions
    (spkcpo, LT+S, MOON_ME_DE440_ME421, refloc OBSERVER). Caller holds the SPICE lock.
    Returns (UTC timestamps, {"sun"|"earth": {"azimuth_deg", "elevation_deg", "distance_km",
    "angular_radius_deg"} arrays}, sun_m (T, 3) Moon-fixed Sun centres in metres, Sun radius m)."""
    start = _validate(latitude_deg, longitude_deg_east, elevation_m, start_utc)
    if not (0 < hours <= ILLUMINATION_MAX_HOURS):
        raise ValueError(f"hours must be > 0 and <= {ILLUMINATION_MAX_HOURS}")
    if not (15.0 <= step_minutes <= MAX_STEP_MIN):
        raise ValueError(f"step_minutes must be in [15, {MAX_STEP_MIN:g}]")
    count = math.floor(hours * 60.0 / step_minutes + 1e-9) + 1
    if count > ILLUMINATION_MAX_SAMPLES:
        raise ValueError(f"the range has {count} time steps; the maximum is {ILLUMINATION_MAX_SAMPLES} "
                         "(use a longer step or a shorter range)")
    if sp.ktotal("ALL") == 0:
        load_kernels()
    obspos, enu = _site(latitude_deg, longitude_deg_east, elevation_m)
    observer = np.asarray(obspos, float) * 1000.0
    times, suns = [], []
    columns = {key: {"azimuth_deg": [], "elevation_deg": [], "distance_km": [], "angular_radius_deg": []}
               for key in _TARGETS}
    try:
        for k in range(count):
            dt = start + timedelta(minutes=step_minutes * k)
            et = _et(dt)
            out = _evaluate(et, obspos, enu)
            for key, body in out.items():
                for name, value in body.items():
                    columns[key][name].append(value)
            state, _lt = sp.spkcpo("SUN", et, MOON_FRAME, "OBSERVER", ABCORR, list(obspos), "MOON", MOON_FRAME)
            times.append(_fmt(dt))
            suns.append(observer + np.asarray(state[:3], float) * 1000.0)
    except sp.SpiceyError as e:
        raise ValueError(f"SPICE could not evaluate this request (kernel coverage?): {e}") from None
    bodies = {key: {name: np.asarray(v) for name, v in cols.items()} for key, cols in columns.items()}
    return times, bodies, np.asarray(suns), BODY_RADIUS_KM["sun"] * 1000.0


def model_metadata():
    manifest = json.loads((ROOT / "kernels_manifest.json").read_text())
    return {
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
    }


def calculate_positions(latitude_deg, longitude_deg_east, elevation_m, timestamp_utc):
    dt = _validate(latitude_deg, longitude_deg_east, elevation_m, timestamp_utc)
    if sp.ktotal("ALL") == 0:
        load_kernels()
    try:
        out = _evaluate(_et(dt), *_site(latitude_deg, longitude_deg_east, elevation_m))
    except sp.SpiceyError as e:
        raise ValueError(f"SPICE could not evaluate this request (kernel coverage?): {e}") from None
    return {
        "site": {"latitude_deg": latitude_deg, "longitude_deg_east": longitude_deg_east,
                 "elevation_m": elevation_m},
        "timestamp_utc": timestamp_utc,
        "sun": out["sun"],
        "earth": out["earth"],
        "model": model_metadata(),
    }


# ---------------------------------------------------------------- time series
MAX_SAMPLES = 1000
MAX_HOURS = 168.0
MIN_STEP_MIN, MAX_STEP_MIN = 10.0, 360.0


def _fmt(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ" if dt.microsecond == 0 else "%Y-%m-%dT%H:%M:%S.%fZ")


def plan_series(latitude_deg, longitude_deg_east, elevation_m, start_utc, hours, step_minutes):
    """Validate a series request (pure Python, no SPICE). Returns (start_dt, timestamps).

    Sampling: t_k = start + k*step for k = 0..K, K = floor(hours*60/step). The end instant
    start+hours is included only if it falls exactly on a step; otherwise the last sample is
    the last one before it. Sample times are UTC wall-clock instants (leap seconds follow SPICE
    str2et, exactly as in /positions).
    """
    start = _validate(latitude_deg, longitude_deg_east, elevation_m, start_utc)
    for name, v in (("hours", hours), ("step_minutes", step_minutes)):
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            raise ValueError(f"{name} must be a finite number, got {v!r}")
    if not 0 < hours <= MAX_HOURS:
        raise ValueError(f"hours must be > 0 and <= {MAX_HOURS:g}, got {hours}")
    if not MIN_STEP_MIN <= step_minutes <= MAX_STEP_MIN:
        raise ValueError(f"step_minutes must be in [{MIN_STEP_MIN:g}, {MAX_STEP_MIN:g}], got {step_minutes}")
    ratio = hours * 60.0 / step_minutes
    k = math.floor(ratio + 1e-9)
    count = k + 1
    if count > MAX_SAMPLES:
        raise ValueError(f"request would produce {count} samples; the maximum is {MAX_SAMPLES} "
                         "(increase step_minutes or reduce hours)")
    step = timedelta(minutes=step_minutes)
    return start, [start + i * step for i in range(count)]


def series_end(start, hours):
    """Requested end instant (start + hours)."""
    return start + timedelta(hours=hours)


def series_epochs(dts):
    """ET for each sample. Caller holds the SPICE lock."""
    try:
        return [_et(d) for d in dts]
    except sp.SpiceyError as e:
        raise ValueError(f"SPICE could not convert a timestamp: {e}") from None


def coverage_windows():
    """Intersection-ready ET coverage per requirement, from the installed kernels (lock held)."""
    wins = [spk_coverage_et(b) for b in (10, 301, 399)]
    # MOON_ME_DE440_ME421 is a fixed-offset TK frame defined relative to MOON_PA_DE440, whose
    # orientation comes from the binary PCK; that PA frame is what the PCK covers.
    wins.append(pck_coverage_et(sp.namfrm("MOON_PA_DE440")))
    return wins


def check_coverage(ets, wins):
    """Raise ValueError unless first and last sample lie in one coverage interval of every kernel."""
    lo, hi = ets[0], ets[-1]  # ets ascending
    for w in wins:
        if not any(a <= lo and hi <= b for a, b in w):
            raise ValueError(
                f"requested span {et_to_utc(lo)}..{et_to_utc(hi)} UTC is outside installed kernel coverage "
                f"(available: {et_to_utc(w[0][0])}..{et_to_utc(w[-1][1])} UTC)")


def evaluate_series_chunk(site, dts, ets):
    """Compute samples for one chunk. Caller holds the SPICE lock. All-or-error."""
    obspos, enu = site
    samples = []
    for dt, et in zip(dts, ets):
        try:
            out = _evaluate(et, obspos, enu)
        except sp.SpiceyError as e:
            raise ValueError(f"SPICE failed at {_fmt(dt)}: {e}") from None
        if not all(math.isfinite(v) for b in out.values() for v in b.values()):
            raise ValueError(f"non-finite result at {_fmt(dt)}")
        samples.append({"timestamp_utc": _fmt(dt), "sun": out["sun"], "earth": out["earth"]})
    return samples


def series_site(latitude_deg, longitude_deg_east, elevation_m):
    return _site(latitude_deg, longitude_deg_east, elevation_m)
