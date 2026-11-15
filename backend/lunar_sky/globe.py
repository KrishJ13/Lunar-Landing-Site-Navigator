"""Geocentric viewing and illumination geometry for the Moon globe."""

from datetime import datetime

import numpy as np
import spiceypy as sp

from .kernels import MOON_FRAME
from .positions import _et


def globe_geometry(timestamp_utc: datetime) -> dict:
    """Calculate Moon-fixed Sun and observer vectors. Caller holds the SPICE lock."""
    observation = _et(timestamp_utc)
    moon_from_earth, light_time = sp.spkpos("MOON", observation, "J2000", "LT+S", "EARTH")
    emission = observation - light_time
    to_moon_frame = sp.pxform("J2000", MOON_FRAME, emission)

    observer = to_moon_frame @ -moon_from_earth
    celestial_north = to_moon_frame[:, 2]
    sun, _ = sp.spkpos("SUN", emission, MOON_FRAME, "LT+S", "MOON")
    # Earth's shadow falls on the Moon at the emission epoch. The Earth
    # intercepts incoming light before it reaches the lunar surface.
    shadow_earth, _ = sp.spkpos("EARTH", emission, MOON_FRAME, "LT", "MOON")
    phase_cosine = np.dot(observer, sun) / (np.linalg.norm(observer) * np.linalg.norm(sun))
    return {
        "frame": MOON_FRAME,
        "observer_km": observer.tolist(),
        "celestial_north": celestial_north.tolist(),
        "sun_km": sun.tolist(),
        "shadow_earth_km": shadow_earth.tolist(),
        "illuminated_fraction": float((1 + np.clip(phase_cosine, -1, 1)) / 2),
    }
