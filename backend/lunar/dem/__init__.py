"""Elevation data (DEM) layer: read LOLA elevation maps and look up terrain height.

Typical use:

    from lunar.dem import load_available, height_at

    products = load_available()
    h = height_at(products, lat=-89.45, lon=222.69)   # metres above 1737.4 km
"""

from .catalog import CATALOG, ProductInfo, best_product, height_at, heights_at, load_available
from .product import DemProduct

__all__ = [
    "CATALOG",
    "DemProduct",
    "ProductInfo",
    "best_product",
    "height_at",
    "heights_at",
    "load_available",
]
