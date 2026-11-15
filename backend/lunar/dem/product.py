"""One LOLA elevation map (a DEM "product"): label + raw height grid.

The .img file is a plain grid of little-endian 32-bit floats, one per pixel,
row by row from the top. Each value is height in KILOMETRES relative to a
sphere of radius 1737.4 km. We memory-map it, so a multi-GB file costs
nothing until pixels are actually read.
"""

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .pds_label import find_object, read_label
from .projections import PolarStereographic, SimpleCylindrical


@dataclass
class DemProduct:
    name: str
    projection: SimpleCylindrical | PolarStereographic
    data: np.ndarray  # (lines, samples), float32, km above reference sphere
    pixel_size_m: float  # nominal ground size of one pixel
    km_scale: float = 1.0  # label SCALING_FACTOR
    # Rows that hold data, inclusive, for a map that covers only part of its grid's
    # latitude range (e.g. SLDEM2015, +/-60 deg, placed in a whole-Moon grid).
    # None means every row.
    valid_lines: tuple[int, int] | None = None

    # ---------- loading ----------

    @classmethod
    def open(cls, label_path: Path) -> "DemProduct":
        """Open a product from its .lbl file; the .img must sit beside it."""
        label_path = Path(label_path)
        label = read_label(label_path)
        image = find_object(label, "IMAGE")
        proj = find_object(label, "IMAGE_MAP_PROJECTION")

        _check_image_format(image, label_path)
        lines, samples = int(image["LINES"]), int(image["LINE_SAMPLES"])
        projection, pixel_size_m = _build_projection(proj, lines, samples)

        img_path = _find_image_file(label_path)
        expected = lines * samples * 4
        actual = img_path.stat().st_size
        if actual != expected:
            raise ValueError(
                f"{img_path.name}: size {actual} bytes, expected {expected} "
                "(incomplete download?)"
            )
        data = np.memmap(img_path, dtype="<f4", mode="r", shape=(lines, samples))
        return cls(
            name=label_path.stem.lower().removesuffix("_float"),
            projection=projection,
            data=data,
            pixel_size_m=pixel_size_m,
            km_scale=float(image.get("SCALING_FACTOR", 1.0)),
        )

    # ---------- queries ----------

    @property
    def shape(self) -> tuple[int, int]:
        return self.data.shape

    def contains(self, lat, lon):
        """True where (lat, lon) can be interpolated from this map."""
        line, sample = self.projection.latlon_to_pixel(lat, lon)
        return self._inside(line, sample)

    def heights_m(self, lat, lon, method: str = "bilinear") -> np.ndarray:
        """Terrain height in metres above the 1737.4 km sphere.

        method:
          "bilinear"  blend of the 4 surrounding pixel centres. Continuous,
                      but its slope jumps at every pixel boundary (faceted).
          "bicubic"   Catmull-Rom (Keys a = -0.5) over the 16 surrounding
                      pixel centres. Passes exactly through every pixel value
                      AND has a continuous slope, so contours and ridge crests
                      come out smooth. Reproduces planes and quadratics exactly.
        Points outside this map's coverage return NaN.
        """
        line, sample = self.projection.latlon_to_pixel(lat, lon)
        line, sample = np.atleast_1d(line), np.atleast_1d(sample)
        inside = self._inside(line, sample)
        out = np.full(line.shape, np.nan)
        if inside.any():
            interpolate = self._bicubic if method == "bicubic" else self._bilinear
            out[inside] = interpolate(line[inside], sample[inside])
        return out * 1000.0 * self.km_scale

    def height_m(self, lat: float, lon: float, method: str = "bilinear") -> float:
        """Scalar convenience wrapper around heights_m."""
        return float(self.heights_m(lat, lon, method)[0])

    # ---------- internals ----------

    def _wraps_longitude(self) -> bool:
        return (
            isinstance(self.projection, SimpleCylindrical)
            and self.projection.is_global_in_longitude
        )

    def _row_bounds(self) -> tuple[int, int]:
        return self.valid_lines if self.valid_lines is not None else (0, self.shape[0] - 1)

    def _inside(self, line, sample):
        lines, samples = self.shape
        line, sample = np.asarray(line), np.asarray(sample)
        if self._wraps_longitude():
            # A whole-Moon cylindrical map covers every latitude (rows are clamped
            # at the poles) and wraps in longitude, so every point is inside;
            # a latitude-limited one only between its first and last data rows.
            if self.valid_lines is None:
                return np.ones(line.shape, dtype=bool)
            lo, hi = self.valid_lines
            return (line >= lo) & (line <= hi)
        lo, hi = self._row_bounds()
        return (line >= lo) & (line <= hi) & (sample >= 0) & (sample <= samples - 1)

    def _bicubic(self, line, sample):
        lines, samples = self.shape
        lo, hi = self._row_bounds()
        line = np.clip(line, float(lo), float(hi))
        l1 = np.minimum(np.floor(line).astype(np.int64), hi - 1)
        tl = line - l1
        s1 = np.floor(sample).astype(np.int64)
        ts = sample - s1
        if not self._wraps_longitude():
            s1 = np.minimum(s1, samples - 2)
            ts = sample - s1

        def rows(k):
            return np.clip(l1 + k, lo, hi)

        def cols(k):
            c = s1 + k
            return np.mod(c, samples) if self._wraps_longitude() else np.clip(c, 0, samples - 1)

        wl = _catmull_rom_weights(tl)
        ws = _catmull_rom_weights(ts)
        d = self.data
        out = np.zeros(line.shape)
        for i, ki in enumerate((-1, 0, 1, 2)):
            r = rows(ki)
            row_sum = np.zeros(line.shape)
            for j, kj in enumerate((-1, 0, 1, 2)):
                row_sum += ws[j] * d[r, cols(kj)]
            out += wl[i] * row_sum
        return out

    def _bilinear(self, line, sample):
        lines, samples = self.shape
        lo, hi = self._row_bounds()
        line = np.clip(line, float(lo), float(hi))
        l0 = np.minimum(np.floor(line).astype(np.int64), hi - 1)
        fl = line - l0

        s0 = np.floor(sample).astype(np.int64)
        fs = sample - s0
        if self._wraps_longitude():
            s0, s1 = np.mod(s0, samples), np.mod(s0 + 1, samples)
        else:
            s0 = np.minimum(s0, samples - 2)
            fs = sample - s0
            s1 = s0 + 1

        d = self.data
        top = d[l0, s0] * (1 - fs) + d[l0, s1] * fs
        bottom = d[l0 + 1, s0] * (1 - fs) + d[l0 + 1, s1] * fs
        return top * (1 - fl) + bottom * fl


def _catmull_rom_weights(t):
    """Weights for samples at offsets -1, 0, 1, 2 (Keys cubic, a = -0.5)."""
    t2, t3 = t * t, t * t * t
    return (
        0.5 * (-t3 + 2 * t2 - t),
        0.5 * (3 * t3 - 5 * t2 + 2),
        0.5 * (-3 * t3 + 4 * t2 + t),
        0.5 * (t3 - t2),
    )


def _check_image_format(image: dict, label_path: Path) -> None:
    if image.get("SAMPLE_TYPE") != "PC_REAL" or int(image.get("SAMPLE_BITS", 0)) != 32:
        raise ValueError(
            f"{label_path.name}: only 32-bit float (PC_REAL) maps are supported, "
            f"got {image.get('SAMPLE_TYPE')}/{image.get('SAMPLE_BITS')}"
        )
    if image.get("UNIT", "KILOMETER") != "KILOMETER":
        raise ValueError(f"{label_path.name}: expected heights in KILOMETER")


def _build_projection(proj: dict, lines: int, samples: int):
    kind = proj["MAP_PROJECTION_TYPE"]
    if kind == "SIMPLE CYLINDRICAL":
        projection = SimpleCylindrical(
            lines=lines,
            samples=samples,
            pixels_per_degree=float(proj["MAP_RESOLUTION"]),
            center_lat=float(proj.get("CENTER_LATITUDE", 0.0)),
            center_lon=float(proj["CENTER_LONGITUDE"]),
            line_offset=float(proj["LINE_PROJECTION_OFFSET"]),
            sample_offset=float(proj["SAMPLE_PROJECTION_OFFSET"]),
            west_lon=float(proj["WESTERNMOST_LONGITUDE"]),
            east_lon=float(proj["EASTERNMOST_LONGITUDE"]),
        )
        pixel_size_m = float(proj["MAP_SCALE"]) * 1000.0  # label gives km/pix
        return projection, pixel_size_m
    if kind == "POLAR STEREOGRAPHIC":
        if lines != samples:
            raise ValueError("polar stereographic maps are expected to be square")
        projection = PolarStereographic(
            size=lines,
            meters_per_pixel=float(proj["MAP_SCALE"]),  # label gives m/pix
            center_lat=float(proj["CENTER_LATITUDE"]),
            line_offset=float(proj["LINE_PROJECTION_OFFSET"]),
            sample_offset=float(proj["SAMPLE_PROJECTION_OFFSET"]),
        )
        return projection, projection.meters_per_pixel
    raise ValueError(f"unsupported map projection {kind!r}")


def _find_image_file(label_path: Path) -> Path:
    """Locate the .img next to a .lbl, ignoring filename case."""
    for candidate in label_path.parent.iterdir():
        if candidate.stem.lower() == label_path.stem.lower() and candidate.suffix.lower() == ".img":
            return candidate
    raise FileNotFoundError(f"no .img file beside {label_path}")
