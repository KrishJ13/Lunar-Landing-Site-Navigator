"""Distance bands for the LOLA-only terrain surface used by Skyline V2."""

import numpy as np

from .foreground import FOREGROUND_BLEND_M, ForegroundSurface, foreground_weight

GLOBAL_MAPS = ("ldem_512", "ldem_256", "ldem_128")
POLAR_BLEND = (320.0, 640.0)
GLOBAL_BLENDS = ((2_000.0, 4_000.0), (12_000.0, 20_000.0))


def transition(distance, interval):
    lower, upper = interval
    t = np.clip((distance - lower) / (upper - lower), 0, 1)
    return t * t * (3 - 2 * t)


class LolaChain:
    def __init__(self, products, lat, lon):
        by_name = {}
        for product in sorted(products, key=lambda p: bool(getattr(p, "is_remote", False))):
            by_name.setdefault(product.name, product)
        missing = [name for name in GLOBAL_MAPS if name not in by_name]
        if missing:
            raise LookupError(f"LOLA resolution chain unavailable: missing {', '.join(missing)}")
        self.global_maps = [by_name[name] for name in GLOBAL_MAPS]
        pole = "s" if lat < 0 else "n"
        polar = by_name.get(f"ldem_875{pole}_5m") if abs(lat) >= 87.5 else None
        self.polar = polar if polar is not None and bool(polar.contains(lat, lon)) else None
        foreground_products = [self.global_maps[0]]
        if self.polar is not None:
            foreground_products.append(self.polar)
            check = by_name.get(f"ldem_80{pole}_20m")
            if check is not None:
                foreground_products.append(check)
        self.foreground = ForegroundSurface(foreground_products, lat, lon)

    @property
    def maps(self):
        names = [product.name for product in self.global_maps]
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
            fallback = self.global_maps[0]
            height[~coverage] = fallback.heights_m(lat[~coverage], lon[~coverage])
            spacing[~coverage] = fallback.pixel_size_m
        return height, spacing
