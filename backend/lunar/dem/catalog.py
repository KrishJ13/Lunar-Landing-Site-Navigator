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
            products.append(DemProduct.open(label))
    return products


def best_product(products: list[DemProduct], lat: float, lon: float) -> DemProduct:
    """Finest-resolution product that covers (lat, lon)."""
    covering = [p for p in products if bool(np.all(p.contains(lat, lon)))]
    if not covering:
        raise LookupError(
            f"no downloaded elevation map covers lat={lat}, lon={lon}; "
            "run scripts/fetch_dem.py"
        )
    return min(covering, key=lambda p: p.pixel_size_m)


def height_at(products: list[DemProduct], lat: float, lon: float) -> float:
    """Terrain height (m above 1737.4 km sphere) from the best available map."""
    return best_product(products, lat, lon).height_m(lat, lon)


def heights_at(products: list[DemProduct], lat, lon):
    """Vectorised height lookup over many points, each from its finest map.

    Maps are tried finest-first; each point takes its height from the first
    map that covers it. Returns (heights_m, pixel_size_m) arrays, the second
    recording which resolution each height came from. Points no map covers
    are NaN in both.
    """
    lat, lon = np.broadcast_arrays(np.atleast_1d(lat), np.atleast_1d(lon))
    heights = np.full(lat.shape, np.nan)
    pixel_size = np.full(lat.shape, np.nan)
    for product in sorted(products, key=lambda p: p.pixel_size_m):
        todo = np.isnan(heights)
        if not todo.any():
            break
        h = product.heights_m(lat[todo], lon[todo])
        found = ~np.isnan(h)
        idx = np.flatnonzero(todo)[found]
        heights.flat[idx] = h[found]
        pixel_size.flat[idx] = product.pixel_size_m
    return heights, pixel_size
