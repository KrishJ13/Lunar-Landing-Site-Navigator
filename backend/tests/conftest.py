"""Test helpers: build tiny synthetic elevation maps in a temp folder.

The synthetic maps use the same label layout and binary format as real LOLA
products, so DemProduct is exercised exactly as it would be on real data,
without any downloads.
"""

from pathlib import Path

import numpy as np
import pytest

CYLINDRICAL_LABEL = """PDS_VERSION_ID = "PDS3"
OBJECT = IMAGE
  LINES = {lines}
  LINE_SAMPLES = {samples}
  SAMPLE_TYPE = PC_REAL
  SAMPLE_BITS = 32
  UNIT = KILOMETER
  SCALING_FACTOR = 1
  OFFSET = 1737.4
END_OBJECT = IMAGE
OBJECT = IMAGE_MAP_PROJECTION
 MAP_PROJECTION_TYPE = "SIMPLE CYLINDRICAL"
 MAP_RESOLUTION = {ppd} <pix/deg>
 CENTER_LATITUDE = 0 <deg>
 CENTER_LONGITUDE = 180 <deg>
 MAP_SCALE = {scale_km} <km/pix>
 WESTERNMOST_LONGITUDE = 0 <deg>
 EASTERNMOST_LONGITUDE = 360 <deg>
 LINE_PROJECTION_OFFSET = {line_off} <pix>
 SAMPLE_PROJECTION_OFFSET = {sample_off} <pix>
END_OBJECT = IMAGE_MAP_PROJECTION
END
"""

POLAR_LABEL = """PDS_VERSION_ID = "PDS3"
OBJECT = UNCOMPRESSED_FILE
  OBJECT = IMAGE
    LINES = {n}
    LINE_SAMPLES = {n}
    SAMPLE_TYPE = PC_REAL
    SAMPLE_BITS = 32
    UNIT = KILOMETER
    SCALING_FACTOR = 1
    OFFSET = 1737.4
  END_OBJECT = IMAGE
END_OBJECT = UNCOMPRESSED_FILE
OBJECT = IMAGE_MAP_PROJECTION
 MAP_PROJECTION_TYPE = "POLAR STEREOGRAPHIC"
 CENTER_LATITUDE = {center_lat} <deg>
 CENTER_LONGITUDE = 0 <deg>
 MAP_SCALE = {scale_m} <m/pix>
 LINE_PROJECTION_OFFSET = {off} <pix>
 SAMPLE_PROJECTION_OFFSET = {off} <pix>
END_OBJECT = IMAGE_MAP_PROJECTION
END
"""


def _write(folder: Path, stem: str, label: str, grid_km: np.ndarray) -> Path:
    label_path = folder / f"{stem}.lbl"
    label_path.write_text(label)
    grid_km.astype("<f4").tofile(folder / f"{stem}.img")
    return label_path


@pytest.fixture
def make_cylindrical(tmp_path):
    """Factory: global cylindrical map whose heights come from fn(lat, lon) in km."""

    def build(fn, ppd: int = 4, stem: str = "synthetic_cyl_float") -> Path:
        lines, samples = 180 * ppd, 360 * ppd
        line_idx, sample_idx = np.mgrid[0:lines, 0:samples]
        lat = 90.0 - (line_idx + 0.5) / ppd
        lon = (sample_idx + 0.5) / ppd
        label = CYLINDRICAL_LABEL.format(
            lines=lines,
            samples=samples,
            ppd=ppd,
            scale_km=1737.4 * np.pi / 180 / ppd,
            line_off=(lines - 1) / 2,
            sample_off=(samples - 1) / 2,
        )
        return _write(tmp_path, stem, label, fn(lat, lon))

    return build


@pytest.fixture
def make_polar(tmp_path):
    """Factory: polar map whose heights come from fn(x_m, y_m) in km.

    x is metres to the right of the pole, y metres towards longitude 0.
    """

    def build(fn, n: int = 101, scale_m: float = 1000.0, south: bool = True, stem: str = "synthetic_polar_float") -> Path:
        off = (n - 1) / 2
        line_idx, sample_idx = np.mgrid[0:n, 0:n]
        x = (sample_idx - off) * scale_m
        y = ((off - line_idx) if south else (line_idx - off)) * scale_m
        label = POLAR_LABEL.format(n=n, center_lat=-90 if south else 90, scale_m=scale_m, off=off)
        return _write(tmp_path, stem, label, fn(x, y))

    return build
