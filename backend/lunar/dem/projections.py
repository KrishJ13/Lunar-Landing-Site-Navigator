"""Map projections used by LOLA elevation maps.

Both classes convert between planetocentric latitude/longitude (degrees,
longitude east-positive) and fractional pixel coordinates (line, sample).

Pixel convention used throughout this package: 0-based, and an integer value
is the CENTRE of a pixel. So line 0.0 is the centre of the top row, and the
top edge of the image is line -0.5. The LOLA labels' *_PROJECTION_OFFSET
values are already in this convention (e.g. 1905.5 for a 3812-pixel image).

All functions accept numpy arrays or plain floats.
"""

from dataclasses import dataclass

import numpy as np

from ..config import MOON_RADIUS_M


def wrap_longitude(lon, west: float = 0.0):
    """Wrap longitude into [west, west + 360)."""
    return west + np.mod(np.asarray(lon, dtype=float) - west, 360.0)


@dataclass(frozen=True)
class SimpleCylindrical:
    """Equirectangular grid: rows are lines of latitude, columns of longitude.

    line   = LINE_PROJECTION_OFFSET   - (lat - CENTER_LATITUDE)  * MAP_RESOLUTION
    sample = SAMPLE_PROJECTION_OFFSET + (lon - CENTER_LONGITUDE) * MAP_RESOLUTION
    """

    lines: int
    samples: int
    pixels_per_degree: float
    center_lat: float
    center_lon: float
    line_offset: float
    sample_offset: float
    west_lon: float
    east_lon: float

    @property
    def is_global_in_longitude(self) -> bool:
        return (self.east_lon - self.west_lon) >= 360.0

    def latlon_to_pixel(self, lat, lon):
        lat = np.asarray(lat, dtype=float)
        lon = wrap_longitude(lon, self.west_lon)
        line = self.line_offset - (lat - self.center_lat) * self.pixels_per_degree
        sample = self.sample_offset + (lon - self.center_lon) * self.pixels_per_degree
        return line, sample

    def pixel_to_latlon(self, line, sample):
        line = np.asarray(line, dtype=float)
        sample = np.asarray(sample, dtype=float)
        lat = self.center_lat + (self.line_offset - line) / self.pixels_per_degree
        lon = self.center_lon + (sample - self.sample_offset) / self.pixels_per_degree
        return lat, wrap_longitude(lon, self.west_lon)


@dataclass(frozen=True)
class PolarStereographic:
    """Spherical polar stereographic grid centred on a pole.

    Orientation (from the LOLA projection description, DSMAP_POLAR.CAT):
      south pole: longitude 0 points UP the image, 90E points RIGHT
      north pole: longitude 0 points DOWN the image, 90E points RIGHT

    Distance from the pole in the map plane:
        r = 2 R tan(colatitude / 2)
        x = r sin(lon)      (to the right)
        y = r cos(lon)      (towards longitude 0)

    Note: the forward (lat/lon -> pixel) equations printed in DSMAP_POLAR.CAT
    contradict its own orientation text for the south pole. We follow the
    inverse equations and the orientation text, which agree with each other;
    tests/test_real_data.py confirms this against the independent global map.
    """

    size: int  # images are square: lines == samples
    meters_per_pixel: float
    center_lat: float  # -90 (south) or +90 (north)
    line_offset: float
    sample_offset: float
    radius_m: float = MOON_RADIUS_M

    @property
    def is_south(self) -> bool:
        return self.center_lat < 0

    def latlon_to_pixel(self, lat, lon):
        lat = np.asarray(lat, dtype=float)
        lon_rad = np.radians(np.asarray(lon, dtype=float))
        colatitude = np.radians(90.0 - np.abs(lat))
        r = 2.0 * self.radius_m * np.tan(colatitude / 2.0)
        x = r * np.sin(lon_rad)
        y = r * np.cos(lon_rad)
        sample = self.sample_offset + x / self.meters_per_pixel
        if self.is_south:
            line = self.line_offset - y / self.meters_per_pixel
        else:
            line = self.line_offset + y / self.meters_per_pixel
        return line, sample

    def pixel_to_latlon(self, line, sample):
        line = np.asarray(line, dtype=float)
        sample = np.asarray(sample, dtype=float)
        x = (sample - self.sample_offset) * self.meters_per_pixel
        if self.is_south:
            y = (self.line_offset - line) * self.meters_per_pixel
        else:
            y = (line - self.line_offset) * self.meters_per_pixel
        r = np.hypot(x, y)
        lon = wrap_longitude(np.degrees(np.arctan2(x, y)))
        colatitude = np.degrees(2.0 * np.arctan(r / (2.0 * self.radius_m)))
        lat = -90.0 + colatitude if self.is_south else 90.0 - colatitude
        return lat, lon
