"""Plot the 360-degree skyline of a site as a panorama (component 4 inspection).

Top panel: skyline elevation vs compass azimuth, one line per observer height,
with the terrain filled below. This is the shape the frontend panorama will draw.
Bottom panel: how far away the skyline-forming terrain is, coloured by the
elevation map resolution it came from.

Usage (from backend/):
    python scripts/skyline_plot.py --lat -89.45 --lon 222.69 --height 2 10 50
"""

import argparse
import sys
import time
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lunar.config import BACKEND_DIR, MOON_RADIUS_M  # noqa: E402
from lunar.dem import load_available  # noqa: E402
from lunar.horizon import DEFAULT_MAX_RANGE_M  # noqa: E402
from lunar.skyline import DEFAULT_AZIMUTH_STEP_DEG, compute_skyline  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--lat", type=float, required=True)
    parser.add_argument("--lon", type=float, required=True, help="east-positive degrees")
    parser.add_argument("--height", type=float, nargs="+", default=[2.0], help="observer height(s) above ground, m")
    parser.add_argument("--az-step", type=float, default=DEFAULT_AZIMUTH_STEP_DEG)
    parser.add_argument("--max-range-km", type=float, default=DEFAULT_MAX_RANGE_M / 1000)
    parser.add_argument("--name", default=None, help="label for the plot title and filename")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    products = load_available()
    if not products:
        sys.exit("No elevation maps found. Run: python scripts/fetch_dem.py --tier starter")

    t0 = time.perf_counter()
    profiles = compute_skyline(
        products, args.lat, args.lon, heights_above_ground_m=args.height,
        azimuth_step_deg=args.az_step, max_range_m=args.max_range_km * 1000,
    )
    elapsed = time.perf_counter() - t0

    first = profiles[0]
    title = args.name or f"lat {args.lat}, lon {args.lon}"
    print(f"{title}: ground {first.ground_m:.0f} m ({first.site_pixel_size_m:g} m map), "
          f"{len(first.azimuth_deg)} azimuths x {len(profiles)} heights in {elapsed:.1f} s")
    for p in profiles:
        hi, lo = np.argmax(p.elevation_deg), np.argmin(p.elevation_deg)
        print(f"  h={p.height_above_ground_m:g} m: skyline from {p.elevation_deg[lo]:+.2f} deg (az {p.azimuth_deg[lo]:g}) "
              f"to {p.elevation_deg[hi]:+.2f} deg (az {p.azimuth_deg[hi]:g}, {p.distance_m[hi] / 1000:.1f} km); "
              f"median distance {np.median(p.distance_m) / 1000:.1f} km; "
              f"{p.at_max_range.sum()} azimuths hit max range")

    fig, (ax, ax_d) = plt.subplots(2, 1, figsize=(14, 7), height_ratios=[2, 1], constrained_layout=True)
    colors = plt.rcParams["axes.prop_cycle"].by_key()["color"]

    floor = min(p.elevation_deg.min() for p in profiles) - 0.5
    ax.fill_between(first.azimuth_deg, first.elevation_deg, floor, color="0.82", step="mid")
    for i, p in enumerate(profiles):
        ax.plot(p.azimuth_deg, p.elevation_deg, color=colors[i % len(colors)], lw=1,
                drawstyle="steps-mid", label=f"skyline, eye {p.height_above_ground_m:g} m above ground")
    dip = -np.degrees(np.arccos(MOON_RADIUS_M / (MOON_RADIUS_M + first.height_above_ground_m)))
    ax.axhline(dip, color="0.4", ls=":", lw=1, label=f"smooth-Moon horizon ({dip:.3f} deg)")
    ax.axhline(0, color="0.6", lw=0.6)
    ax.set_ylim(floor, None)
    ax.set_ylabel("elevation (deg)")
    ax.set_title(f"360\N{DEGREE SIGN} skyline - {title} (ground {first.ground_m:.0f} m)")
    ax.legend(loc="upper right", fontsize=8)

    sc = ax_d.scatter(first.azimuth_deg, first.distance_m / 1000, c=first.skyline_pixel_size_m,
                      s=4, cmap="viridis", norm=matplotlib.colors.LogNorm())
    fig.colorbar(sc, ax=ax_d, label="map m/pixel at skyline")
    ax_d.set_yscale("log")
    ax_d.set_ylabel("skyline distance (km)")

    for a in (ax, ax_d):
        a.set_xlim(0, 360)
        a.set_xticks(range(0, 361, 45), ["N", "NE", "E", "SE", "S", "SW", "W", "NW", "N"])
    ax_d.set_xlabel("compass azimuth" + (" (at the pole: relative to meridian lon)" if abs(args.lat) > 89.999 else ""))

    slug = (args.name or f"{args.lat}_{args.lon}").replace(" ", "_").lower()
    out = args.out or BACKEND_DIR / "output" / f"skyline_{slug}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=130)
    print(f"  wrote {out}")


if __name__ == "__main__":
    main()
