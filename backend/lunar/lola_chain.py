"""Distance bands for the terrain surface of the Skyline V2/V3 panoramas.

Three maps, near to far, blended over GLOBAL_BLENDS (plus the 5 m polar map at
the feet beyond 87.5 deg):
  * "lola_chain" (V2): the cylindrical LOLA grids ldem_512 -> ldem_256 -> ldem_128.
  * "best" (V3, best_maps): the highest-quality map for each place. Near the
    poles the cylindrical grids are a poor fit: a small circle crosses every
    longitude (thousands of 256-px blocks per panorama) and they carry isolated
    spikes there; the polar stereographic LOLA maps are made for these regions.
    Below 60 deg, SLDEM2015 (LOLA + SELENE stereo, no track artefacts) near the site.
"""

import numpy as np

from .foreground import FOREGROUND_BLEND_M, ForegroundSurface, foreground_weight

GLOBAL_MAPS = ("ldem_512", "ldem_256", "ldem_128")
POLAR_BLEND = (320.0, 640.0)
GLOBAL_BLENDS = ((2_000.0, 4_000.0), (12_000.0, 20_000.0))


def transition(distance, interval):
    lower, upper = interval
    t = np.clip((distance - lower) / (upper - lower), 0, 1)
    return t * t * (3 - 2 * t)


def best_maps(lat):
    """Near, mid and far maps for a site at latitude `lat` (see the module docstring)."""
    pole = "s" if lat < 0 else "n"
    if abs(lat) >= 80.0:
        return (f"ldem_80{pole}_20m", f"ldem_75{pole}_120m", f"ldem_60{pole}_240m")
    if abs(lat) >= 60.0:
        return (f"ldem_60{pole}_60m", f"ldem_60{pole}_120m", f"ldem_60{pole}_240m")
    return ("sldem2015_512", "ldem_256", "ldem_128")


class LolaChain:
    def __init__(self, products, lat, lon, maps=GLOBAL_MAPS):
        by_name = {}
        for product in sorted(products, key=lambda p: bool(getattr(p, "is_remote", False))):
            by_name.setdefault(product.name, product)
        self.fallback = by_name.get("ldem_128") if maps != GLOBAL_MAPS else None
        missing = [name for name in maps if name not in by_name]
        if missing and self.fallback is None:
            raise LookupError(f"Elevation maps unavailable: missing {', '.join(missing)}")
        self.global_maps = [by_name.get(name, self.fallback) for name in maps]
        self.used_fallback = False
        pole = "s" if lat < 0 else "n"
        polar = by_name.get(f"ldem_875{pole}_5m") if abs(lat) >= 87.5 else None
        self.polar = polar if polar is not None and bool(polar.contains(lat, lon)) else None
        foreground_products = [self.global_maps[0]]
        if self.polar is not None:
            foreground_products.append(self.polar)
            check = by_name.get(f"ldem_80{pole}_20m")
            if check is not None:
                foreground_products.append(check)
        self.foreground = ForegroundSurface(foreground_products, lat, lon, fallback=self.fallback)

    @property
    def maps(self):
        names = list(dict.fromkeys(product.name for product in self.global_maps))
        if self.used_fallback and self.fallback is not None and self.fallback.name not in names:
            names.append(self.fallback.name)
        return [self.polar.name, *names] if self.polar is not None else names

    def normal_spacing(self, distance):
        near, mid, far = [product.pixel_size_m for product in self.global_maps]
        spacing = near + (mid - near) * transition(distance, GLOBAL_BLENDS[0])
        spacing += (far - mid) * transition(distance, GLOBAL_BLENDS[1])
        if self.polar is not None:
            spacing -= (near - self.polar.pixel_size_m) * (1 - transition(distance, POLAR_BLEND))
        return spacing

    def sample(self, lat, lon, azimuth, distance):
        """Return elevations and contributing grid spacing at the same geodetic points."""
        lat, lon, azimuth, distance = np.broadcast_arrays(lat, lon, azimuth, distance)
        to_mid = transition(distance, GLOBAL_BLENDS[0])
        to_far = transition(distance, GLOBAL_BLENDS[1])
        weights = [1 - to_mid, to_mid - to_far, to_far]
        maps = self.global_maps
        if self.polar is not None:
            # Fade before the nominal polar coverage edge as well as by range.
            edge_m = (np.abs(lat) - 87.5) * 30_323.0
            polar_weight = (1 - transition(distance, POLAR_BLEND)) * transition(edge_m, (0, 100))
            weights = [polar_weight, *[weight * (1 - polar_weight) for weight in weights]]
            maps = [self.polar, *maps]

        height, spacing, total, dominant = (np.zeros(distance.shape) for _ in range(4))
        for product, weight in zip(maps, weights):
            take = weight > 0
            if not take.any():
                continue
            values = product.heights_m(lat[take], lon[take])
            if product is self.polar:
                # Reuse the spike-checked foreground surface inside its patch.
                close = distance[take] < FOREGROUND_BLEND_M
                d, a = distance[take][close], np.radians(azimuth[take][close])
                values[close] = self.foreground.blend(values[close], d * np.sin(a), d * np.cos(a), d)
            valid = np.isfinite(values)
            indices = np.flatnonzero(take)[valid]
            used_weight = weight.flat[indices]
            total.flat[indices] += used_weight
            height.flat[indices] += used_weight * values[valid]
            stronger = used_weight > dominant.flat[indices]
            spacing.flat[indices[stronger]] = product.pixel_size_m
            dominant.flat[indices[stronger]] = used_weight[stronger]

        coverage = total > 0
        np.divide(height, total, out=height, where=coverage)
        if not coverage.all():
            fallback = self.fallback if self.fallback is not None else self.global_maps[0]
            values = fallback.heights_m(lat[~coverage], lon[~coverage])
            height[~coverage] = values
            spacing[~coverage] = fallback.pixel_size_m
            self.used_fallback |= self.fallback is not None and bool(np.isfinite(values).any())
        return height, spacing
