"""3D geometry on the Moon: positions, the local horizon frame, and directions.

Component 2. Pure maths, no data files. Everything works on numpy arrays and
broadcasts, so a whole ray of points can be processed in one call.

Frame: Moon-centred, Moon-fixed Cartesian (MOON_ME, the frame LOLA and
Horizons use), in metres:
    +x  towards (lat 0, lon 0), the mean sub-Earth point
    +y  towards (lat 0, lon 90E)
    +z  towards the north pole

The Moon is treated as a sphere of radius 1737.4 km; terrain is added on top
as a height. This matches the LOLA maps (heights above that sphere) exactly.

Function overview
    surface_vector(lat, lon, height)      lat/lon/height  -> 3D position
    vector_to_latlon(vec)                 3D position     -> lat/lon/height
    enu_basis(lat, lon)                   local East, North, Up unit vectors
    destination(lat, lon, azimuth, dist)  walk along the surface -> lat/lon
    look_angles(observer, target, basis)  azimuth, elevation, range to a target
"""

import numpy as np

from .config import MOON_RADIUS_M


def _stack(x, y, z) -> np.ndarray:
    """Combine component arrays into vectors with shape (..., 3)."""
    return np.stack(np.broadcast_arrays(x, y, z), axis=-1)


def dot(a, b) -> np.ndarray:
    """Dot product over the last axis, broadcasting (..., 3) against (3,).

    Written out instead of using `@`: Apple's Accelerate BLAS, which numpy uses
    on macOS, emits spurious overflow warnings for matmul on these shapes.
    """
    return np.sum(np.asarray(a) * np.asarray(b), axis=-1)


def unit_up(lat, lon) -> np.ndarray:
    """Unit vector from the Moon's centre through (lat, lon): local 'up'."""
    phi, lam = np.radians(lat), np.radians(lon)
    return _stack(np.cos(phi) * np.cos(lam), np.cos(phi) * np.sin(lam), np.sin(phi))


def surface_vector(lat, lon, height_m=0.0, radius_m: float = MOON_RADIUS_M) -> np.ndarray:
    """Position of a point `height_m` above the reference sphere.

        P = (R + h) * U(lat, lon)
    """
    return (radius_m + np.asarray(height_m, dtype=float))[..., None] * unit_up(lat, lon)


def vector_to_latlon(vec, radius_m: float = MOON_RADIUS_M):
    """Inverse of surface_vector: returns (lat, lon in [0, 360), height_m)."""
    vec = np.asarray(vec, dtype=float)
    x, y, z = vec[..., 0], vec[..., 1], vec[..., 2]
    r = np.sqrt(x * x + y * y + z * z)
    lat = np.degrees(np.arcsin(z / r))
    lon = np.mod(np.degrees(np.arctan2(y, x)), 360.0)
    return lat, lon, r - radius_m


def enu_basis(lat, lon):
    """Local horizon frame at (lat, lon): unit vectors East, North, Up.

        U = ( cos(lat) cos(lon),  cos(lat) sin(lon), sin(lat))
        E = (-sin(lon),           cos(lon),          0       )
        N = (-sin(lat) cos(lon), -sin(lat) sin(lon), cos(lat))

    The horizontal plane is the one perpendicular to U. E x N = U (right-handed).

    At exactly a pole every direction is 'north' (or 'south'), so the formulas
    instead define North as pointing along the meridian `lon` that was passed
    in. Azimuths at a pole are therefore relative to that meridian.
    """
    phi, lam = np.radians(lat), np.radians(lon)
    sp, cp, sl, cl = np.sin(phi), np.cos(phi), np.sin(lam), np.cos(lam)
    east = _stack(-sl, cl, np.zeros_like(sl))
    north = _stack(-sp * cl, -sp * sl, cp)
    up = _stack(cp * cl, cp * sl, sp)
    return east, north, up


def horizontal_direction(lat, lon, azimuth_deg) -> np.ndarray:
    """Unit vector in the horizontal plane pointing at a compass azimuth.

    Azimuth is measured clockwise from North: 0 = N, 90 = E, 180 = S, 270 = W.
        D = cos(A) N + sin(A) E
    """
    east, north, _ = enu_basis(lat, lon)
    a = np.radians(np.asarray(azimuth_deg, dtype=float))[..., None]
    return np.cos(a) * north + np.sin(a) * east


def destination(lat, lon, azimuth_deg, distance_m, radius_m: float = MOON_RADIUS_M):
    """Where you end up walking `distance_m` along the surface from (lat, lon),
    starting in compass direction `azimuth_deg` and going straight ahead
    (a great circle).

    With central angle d = distance / R, start direction U and heading D:
        P2 = cos(d) U + sin(d) D

    Distance is measured along the reference sphere, not along the terrain.
    Works at the poles (heading is relative to the meridian `lon`, as in
    enu_basis). Returns (lat2, lon2) with lon2 in [0, 360).
    """
    up = unit_up(lat, lon)
    heading = horizontal_direction(lat, lon, azimuth_deg)
    d = (np.asarray(distance_m, dtype=float) / radius_m)[..., None]
    end = np.cos(d) * up + np.sin(d) * heading
    lat2, lon2, _ = vector_to_latlon(end, radius_m=1.0)
    return lat2, lon2


def look_angles(observer, targets, basis):
    """Azimuth, elevation and range from an observer to target point(s).

    observer : (3,) position vector
    targets  : (..., 3) position vectors
    basis    : (east, north, up) at the observer, from enu_basis

        rho = target - observer
        e, n, u = rho.E, rho.N, rho.U
        elevation = asin(u / |rho|)         degrees above the horizontal plane
        azimuth   = atan2(e, n)             degrees clockwise from North

    Returns (azimuth_deg in [0, 360), elevation_deg, range_m).
    """
    east, north, up = basis
    rho = np.asarray(targets, dtype=float) - np.asarray(observer, dtype=float)
    e, n, u = dot(rho, east), dot(rho, north), dot(rho, up)
    rng = np.sqrt(e * e + n * n + u * u)
    elevation = np.degrees(np.arcsin(np.clip(u / rng, -1.0, 1.0)))
    azimuth = np.mod(np.degrees(np.arctan2(e, n)), 360.0)
    return azimuth, elevation, rng
