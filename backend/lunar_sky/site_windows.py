"""Visibility at a single site using the same terrain silhouette as the panorama."""

from datetime import timedelta

import numpy as np
import spiceypy as sp

from . import positions

# Match the chord midpoints in Skyline V3's visibleFraction model.
DISC_OFFSETS = (np.arange(64) + 0.5) / 32 - 1
DISC_HEIGHTS = np.sqrt(1 - DISC_OFFSETS**2)
BODIES = ("sun", "earth")
LOOKAHEAD_S = 30 * 86400
SCAN_BATCH = 512


def find_windows(times, margins, margin_at):
    """Bracket each detected crossing, refine it, and clip windows to the requested span."""
    visible = margins > 0
    start = float(times[0]) if visible[0] else None
    events = []
    windows = []
    for i in np.flatnonzero(visible[:-1] != visible[1:]):
        left, right = float(times[i]), float(times[i + 1])
        while right - left > 1:
            mid = (left + right) / 2
            if (margin_at(mid) > 0) == visible[i]:
                left = mid
            else:
                right = mid
        crossing = (left + right) / 2
        if visible[i]:
            events.append({"at_s": crossing, "kind": "set"})
            windows.append({"start_s": start, "end_s": crossing})
            start = None
        else:
            events.append({"at_s": crossing, "kind": "rise"})
            start = crossing
    if start is not None:
        windows.append({"start_s": start, "end_s": float(times[-1])})
    return {
        "events": events,
        "windows": windows,
        "visible_duration_s": sum(w["end_s"] - w["start_s"] for w in windows),
    }


def visibility_windows(lat, lon, eye_m, start_utc, hours, skyline_deg, coverage, spice_lock,
                       *, include_next_event=False):
    """Scan independently of playback. Sun uses the upper limb and Earth uses its centre."""
    start = positions._validate(lat, lon, eye_m, start_utc)
    horizon = np.asarray(skyline_deg)
    if not np.all(np.isfinite(horizon) & (np.abs(horizon) <= 90)):
        raise ValueError("Skyline must contain finite elevations between -90 and 90 degrees.")
    bearings = np.linspace(0, 360, len(horizon) + 1)
    horizon = np.append(horizon, horizon[0])
    duration = timedelta(hours=hours).total_seconds()
    cadence = 120 if hours <= 31 * 24 else 300
    times = np.r_[np.arange(0, duration, cadence), duration]
    site = positions.series_site(lat, lon, eye_m)

    def ephemeris(offsets):
        dts = [start + timedelta(seconds=float(value)) for value in offsets]
        with spice_lock:
            epochs = positions.series_epochs(dts)
            return positions.evaluate_series_chunk(site, dts, epochs)

    def evaluate(offsets):
        samples = ephemeris(offsets)
        sun, earth = (
            np.array([(sample[body]["azimuth_deg"], sample[body]["elevation_deg"],
                       sample[body]["angular_radius_deg"]) for sample in samples]).T
            for body in BODIES
        )
        az, el, radius = sun[:, :, None]
        limb_az = (az + radius * DISC_OFFSETS) % 360
        sun_margin = (el + radius * DISC_HEIGHTS - np.interp(limb_az, bearings, horizon)).max(axis=1)
        earth_margin = earth[1] - np.interp(earth[0], bearings, horizon)
        return np.stack((sun_margin, earth_margin))

    with spice_lock:
        try:
            epochs = positions.series_epochs([start, start + timedelta(seconds=duration)])
            positions.check_coverage(epochs, coverage)
        except sp.SpiceyError as exc:
            raise ValueError("Could not check lunar ephemeris coverage for this date range.") from exc

    # Release the SPICE lock between batches so playback requests can still make progress.
    margins = np.hstack([evaluate(times[i:i + SCAN_BATCH]) for i in range(0, len(times), SCAN_BATCH)])
    result = {"start_utc": positions._fmt(start), "duration_s": duration, "cadence_s": cadence}
    for idx, body in enumerate(BODIES):
        result[body] = find_windows(times, margins[idx], lambda offset: evaluate([offset])[idx, 0])
    earth_windows = result["earth"]["windows"]
    for i in range(0, len(earth_windows), SCAN_BATCH):
        batch = earth_windows[i:i + SCAN_BATCH]
        for window, sample in zip(batch, ephemeris([window["start_s"] for window in batch])):
            earth = sample["earth"]
            azimuth, elevation = earth["azimuth_deg"], earth["elevation_deg"]
            window["opening_direction"] = {
                "azimuth_deg": azimuth,
                "elevation_deg": elevation,
                "clearance_deg": elevation - float(np.interp(azimuth, bearings, horizon)),
            }
    if include_next_event:
        end = duration + LOOKAHEAD_S
        try:
            with spice_lock:
                epochs = positions.series_epochs([start + timedelta(seconds=offset) for offset in (duration, end)])
                positions.check_coverage(epochs, coverage)
            result["after_mission"] = {
                "searched_until_s": end,
                "events": next_crossings(duration, end, cadence, margins[:, -1], evaluate),
            }
        except ValueError:
            # The mission itself may still be covered when future ephemeris is unavailable.
            result["after_mission"] = None
    return result


def next_crossings(start, end, cadence, start_margins, evaluate):
    """Find the first change for each body, stopping as soon as both are known."""
    offsets = np.r_[np.arange(start + cadence, end, cadence), end]
    events = {}
    previous_time, previous_margins = start, start_margins
    for i in range(0, len(offsets), SCAN_BATCH):
        batch = offsets[i:i + SCAN_BATCH]
        times = np.r_[previous_time, batch]
        margins = np.column_stack((previous_margins, evaluate(batch)))
        for idx, body in enumerate(BODIES):
            if body not in events:
                crossings = find_windows(times, margins[idx], lambda offset: evaluate([offset])[idx, 0])["events"]
                if crossings:
                    events[body] = crossings[0]
        if len(events) == len(BODIES):
            break
        previous_time, previous_margins = times[-1], margins[:, -1]
    return events
