"""Ridgelines and peaks around the observer (reconstruction step 2).

Step 1 (lunar.ridges) gives, for every compass direction, the visible ridge
crests along that direction. A real ridge or mountain is seen across many
neighbouring directions, so here crests are LINKED across directions into
ridgelines: continuous lines of crest points belonging to one physical
feature. Each ridgeline then gets a summit, and the summits form a peak list.

Linking rule (greedy, direction by direction, in both senses of "nearest"):
a crest in direction i continues into direction i+g (g = 1..MAX_GAP) if
  - its distance changes by at most a factor DISTANCE_RATIO (same feature,
    not a different ridge in front or behind), and
  - its elevation angle changes by at most MAX_DELTA_EL_DEG * g;
among candidates, the one with the smallest combined change wins. Gaps of
up to MAX_GAP directions (a crest briefly missing, e.g. dipping under the
0.01 deg filter) are bridged.

Ridgelines are returned far to near (by median distance), the order in which
a painter's-algorithm renderer should draw them.
"""

from dataclasses import dataclass, field

import numpy as np

from .ridges import CrestView

DISTANCE_RATIO = 1.25
MAX_DELTA_EL_DEG = 0.6
MAX_GAP = 3
# Every fragment is kept, however short: a layered (painter's) renderer needs
# the nearest crest in every direction, or farther layers would show through.


@dataclass
class Ridgeline:
    # Per point (along the line, azimuth increasing; azimuth is unwrapped, so
    # it can exceed 360 when the line crosses north):
    azimuth_deg: list[float] = field(default_factory=list)
    elevation_deg: list[float] = field(default_factory=list)
    distance_m: list[float] = field(default_factory=list)
    height_m: list[float] = field(default_factory=list)
    lat: list[float] = field(default_factory=list)
    lon: list[float] = field(default_factory=list)
    skyline: list[bool] = field(default_factory=list)

    @property
    def span_deg(self) -> float:
        return self.azimuth_deg[-1] - self.azimuth_deg[0] if self.azimuth_deg else 0.0

    @property
    def median_distance_m(self) -> float:
        return float(np.median(self.distance_m))

    def summit_index(self) -> int:
        """Point of this ridgeline that appears highest in the view."""
        return int(np.argmax(self.elevation_deg))

    def add(self, az: float, crest: np.ndarray) -> None:
        self.azimuth_deg.append(float(az))
        self.elevation_deg.append(float(crest[1]))
        self.distance_m.append(float(crest[0]))
        self.height_m.append(float(crest[2]))
        self.lat.append(float(crest[3]))
        self.lon.append(float(crest[4]))
        self.skyline.append(bool(crest[5]))


@dataclass(frozen=True)
class Peak:
    azimuth_deg: float
    elevation_deg: float
    distance_m: float
    height_m: float  # vs the Moon's mean level
    lat: float
    lon: float
    on_skyline: bool
    ridgeline: int  # index into the ridgeline list


def link_ridgelines(view: CrestView) -> list[Ridgeline]:
    """Chain crests across directions into ridgelines, sorted far to near."""
    az = view.azimuth_deg
    n = len(az)
    step = float(az[1] - az[0]) if n > 1 else 360.0
    used = [np.zeros(len(c), dtype=bool) for c in view.crests]
    lines: list[Ridgeline] = []

    for i in range(n):
        for j in range(len(view.crests[i])):
            if used[i][j]:
                continue
            used[i][j] = True
            line = Ridgeline()
            line.add(az[i], view.crests[i][j])
            ci, current, travelled = i, view.crests[i][j], 0
            while True:
                best, best_cost = None, np.inf
                for g in range(1, MAX_GAP + 1):
                    if travelled + g >= n:  # gone all the way round
                        break
                    k = (ci + g) % n
                    for m, cand in enumerate(view.crests[k]):
                        if used[k][m]:
                            continue
                        ratio = max(cand[0], current[0]) / max(min(cand[0], current[0]), 1e-9)
                        d_el = abs(cand[1] - current[1])
                        if ratio > DISTANCE_RATIO or d_el > MAX_DELTA_EL_DEG * g:
                            continue
                        cost = np.log(ratio) / np.log(DISTANCE_RATIO) + d_el / MAX_DELTA_EL_DEG + (g - 1)
                        if cost < best_cost:
                            best, best_cost = (k, m, g), cost
                    if best is not None:
                        break  # prefer the nearest direction that has a match
                if best is None:
                    break
                k, m, g = best
                used[k][m] = True
                travelled += g
                ci, current = k, view.crests[k][m]
                line.add(az[i] + travelled * step, current)
            lines.append(line)

    lines = _merge_across_north(lines, step)
    lines.sort(key=lambda r: -r.median_distance_m)  # far to near
    return lines


def _merge_across_north(lines: list[Ridgeline], step: float) -> list[Ridgeline]:
    """Chains start at azimuth 0, so a ridge crossing due north is found as
    two pieces: one ending just below 360 and one starting just after 0.
    Join such pieces when they match by the same linking rule."""
    starts = [r for r in lines if r.azimuth_deg[0] < MAX_GAP * step]
    merged_away = set()
    for a in lines:
        end = a.azimuth_deg[-1]
        if end % 360.0 < 360.0 - MAX_GAP * step - 1e-9 or id(a) in merged_away:
            continue
        for b in starts:
            if b is a or id(b) in merged_away:
                continue
            gap = (b.azimuth_deg[0] + 360.0) - end
            if not 0 < gap <= MAX_GAP * step + 1e-9:
                continue
            ratio = max(a.distance_m[-1], b.distance_m[0]) / max(min(a.distance_m[-1], b.distance_m[0]), 1e-9)
            if ratio <= DISTANCE_RATIO and abs(a.elevation_deg[-1] - b.elevation_deg[0]) <= MAX_DELTA_EL_DEG * gap / step:
                offset = end - (end % 360.0) + 360.0  # continue b's azimuths past a's end
                for name in ("azimuth_deg", "elevation_deg", "distance_m", "height_m", "lat", "lon", "skyline"):
                    values = getattr(b, name)
                    getattr(a, name).extend([v + offset for v in values] if name == "azimuth_deg" else values)
                merged_away.add(id(b))
                break
    return [r for r in lines if id(r) not in merged_away]


def find_peaks(
    lines: list[Ridgeline],
    max_peaks: int = 12,
    min_separation_deg: float = 3.0,
    min_distance_m: float = 1_000.0,
) -> list[Peak]:
    """One summit per ridgeline (its highest point in the view), the most
    prominent first, keeping peaks at least `min_separation_deg` apart.

    Summits closer than `min_distance_m` are left out: on high ground the
    nearest "crest" is just the edge of the ground you stand on, not a peak.
    They remain in the ridgelines, so they are still drawn."""
    summits = []
    for idx, line in enumerate(lines):
        s = line.summit_index()
        if line.distance_m[s] < min_distance_m:
            continue
        summits.append(
            Peak(
                azimuth_deg=line.azimuth_deg[s] % 360.0,
                elevation_deg=line.elevation_deg[s],
                distance_m=line.distance_m[s],
                height_m=line.height_m[s],
                lat=line.lat[s],
                lon=line.lon[s],
                on_skyline=line.skyline[s],
                ridgeline=idx,
            )
        )
    # skyline summits first, then by how high they appear
    summits.sort(key=lambda p: (not p.on_skyline, -p.elevation_deg))
    chosen: list[Peak] = []
    for p in summits:
        if all(abs((p.azimuth_deg - q.azimuth_deg + 180) % 360 - 180) >= min_separation_deg for q in chosen):
            chosen.append(p)
        if len(chosen) >= max_peaks:
            break
    return chosen
