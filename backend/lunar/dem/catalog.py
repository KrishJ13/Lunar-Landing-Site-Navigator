"""Which LOLA elevation maps we know about, and picking the right one.

All products come from NASA's Planetary Data System (PDS) Geosciences Node:
LRO LOLA Gridded Data Records, dataset LRO-L-LOLA-4-GDR-V1.0.

Coverage strategy for the whole Moon:
  * a GLOBAL cylindrical map covers every site, everywhere;
  * POLAR stereographic maps add much finer detail near the poles, where the
    cylindrical grid is badly stretched and where the challenge is focused.
For any point we use the finest map that covers it.

Sets ("tiers") let us start small and add detail later:
  starter  ~128 MB  - enough to prove the whole pipeline end-to-end
  polar    ~289 MB  - finer polar detail, north pole included
  hires    ~15 GB   - near-final quality (download only what you need)
"""

import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..config import DEM_DIR
from .product import DemProduct

PDS_BASE = (
    "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/"
    "lrolol_1xxx/data/lola_gdr"
)


@dataclass(frozen=True)
class ProductInfo:
    name: str  # e.g. "ldem_16"
    folder: str  # "cylindrical" or "polar"
    approx_bytes: int  # .img size, from the PDS server
    pixel_size_m: float
    coverage: str
    tier: str

    @property
    def stem(self) -> str:
        return f"{self.name}_float"

    def url(self, suffix: str) -> str:
        return f"{PDS_BASE}/{self.folder}/float_img/{self.stem}.{suffix}"


CATALOG: tuple[ProductInfo, ...] = (
    # --- starter ---
    ProductInfo("ldem_4", "cylindrical", 4_147_200, 7_580, "global", "starter"),
    ProductInfo("ldem_16", "cylindrical", 66_355_200, 1_895, "global", "starter"),
    ProductInfo("ldem_75s_240m", "polar", 58_125_376, 240, "75S-90S", "starter"),
    # --- polar ---
    ProductInfo("ldem_75n_240m", "polar", 58_125_376, 240, "75N-90N", "polar"),
    ProductInfo("ldem_80s_80m", "polar", 231_040_000, 80, "80S-90S", "polar"),
    # --- hires ---
    ProductInfo("ldem_128", "cylindrical", 4_246_732_800, 237, "global", "hires"),
    ProductInfo("ldem_80s_20m", "polar", 3_696_640_000, 20, "80S-90S", "hires"),
    ProductInfo("ldem_85s_10m", "polar", 3_681_091_584, 10, "85S-90S", "hires"),
    ProductInfo("ldem_875s_5m", "polar", 3_681_091_584, 5, "87.5S-90S", "hires"),
)


def catalog_entry(name: str) -> ProductInfo:
    for info in CATALOG:
        if info.name == name:
            return info
    raise KeyError(f"unknown product {name!r}")


def load_available(dem_dir: Path = DEM_DIR) -> list[DemProduct]:
    """Open every catalogued product that has been downloaded into dem_dir."""
    products = []
    for info in CATALOG:
        label = Path(dem_dir) / f"{info.stem}.lbl"
        if label.exists():
            try:
                products.append(DemProduct.open(label))
            except FileNotFoundError as exc:  # label present but image missing: interrupted download
                logging.getLogger(__name__).warning("skipping incomplete elevation map %s: %s", info.stem, exc)
    return products


def _preference(products, target_m=None):
    """Products in the order to try them.

    Without a target: finest first. With a target spacing (metres): first the
    products no coarser than the target, coarsest of those first (the one
    closest to the target), then the coarser ones, finest of those first.
    Local files win ties with remote ones, which then cost no network traffic.
    """
    def key(p):
        return (p.pixel_size_m, bool(getattr(p, "is_remote", False)))

    ordered = sorted(products, key=key)
    if target_m is None:
        return ordered
    fine = [p for p in ordered if p.pixel_size_m <= target_m]
    fine.sort(key=lambda p: (-p.pixel_size_m, bool(getattr(p, "is_remote", False))))
    return fine + [p for p in ordered if p.pixel_size_m > target_m]


def best_product(products: list[DemProduct], lat: float, lon: float, target_m: float | None = None) -> DemProduct:
    """Product to use at (lat, lon): the finest that covers it or, given a target
    spacing in metres, the one closest to it from below (see _preference)."""
    for p in _preference(products, target_m):
        if bool(np.all(p.contains(lat, lon))):
            return p
    raise LookupError(
        f"no available elevation map covers lat={lat}, lon={lon}; "
        "run scripts/fetch_dem.py"
    )


def height_at(products: list[DemProduct], lat: float, lon: float) -> float:
    """Terrain height (m above 1737.4 km sphere) from the best available map."""
    return best_product(products, lat, lon).height_m(lat, lon)


def heights_at(products: list[DemProduct], lat, lon, method: str = "bilinear", target_m=None):
    """Vectorised height lookup over many points.

    Without `target_m`, each point takes its height from the finest map that
    covers it. With `target_m` (metres; a scalar or one value per point), each
    point uses the coarsest map no coarser than its target, or failing that
    the finest coarser one. This keeps far-away samples, which need only
    coarse spacing, from pulling in fine remote data they cannot use.

    Returns (heights_m, pixel_size_m) arrays, the second recording which
    resolution each height came from. Points no map covers are NaN in both.
    `method` is "bilinear" or "bicubic" (see DemProduct).
    """
    lat, lon = np.broadcast_arrays(np.atleast_1d(lat), np.atleast_1d(lon))
    heights = np.full(lat.shape, np.nan)
    pixel_size = np.full(lat.shape, np.nan)
    if target_m is not None:
        target = np.broadcast_to(np.asarray(target_m, dtype=float), lat.shape)
        # Pass 1: maps no coarser than the target, coarsest first.
        coarsest_first = sorted(products, key=lambda p: (-p.pixel_size_m, bool(getattr(p, "is_remote", False))))
        for product in coarsest_first:
            todo = np.isnan(heights) & (product.pixel_size_m <= target)
            _fill(product, lat, lon, method, todo, heights, pixel_size)
        # Pass 2: anything left (target finer than every covering map), finest first.
        for product in _preference(products):
            _fill(product, lat, lon, method, np.isnan(heights), heights, pixel_size)
        return heights, pixel_size
    for product in _preference(products):
        todo = np.isnan(heights)
        if not todo.any():
            break
        h = product.heights_m(lat[todo], lon[todo], method)
        found = ~np.isnan(h)
        idx = np.flatnonzero(todo)[found]
        heights.flat[idx] = h[found]
        pixel_size.flat[idx] = product.pixel_size_m
    return heights, pixel_size


def _fill(product, lat, lon, method, todo, heights, pixel_size):
    if not todo.any():
        return
    h = product.heights_m(lat[todo], lon[todo], method)
    found = ~np.isnan(h)
    idx = np.flatnonzero(todo)[found]
    heights.flat[idx] = h[found]
    pixel_size.flat[idx] = product.pixel_size_m
