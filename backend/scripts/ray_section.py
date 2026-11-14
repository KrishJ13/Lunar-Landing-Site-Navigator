"""Plot a terrain cross-section along one compass direction from a site.

A debugging / inspection view for the horizon ray (component 3). Two panels:
  1. Side view: the terrain in the observer's vertical plane, with the Moon's
     curvature, the eye, and the line of sight to the skyline point.
  2. Elevation angle of every terrain sample vs distance: the skyline is the
     highest point of this curve.

Usage (from backend/):
    python scripts/ray_section.py --lat -89.45 --lon 222.69 --az 144.74
    python scripts/ray_section.py --lat -89.45 --lon 222.69 --az 144.74 --height 2 10 50

Writes a PNG into backend/output/ (git-ignored) and prints the skyline points.
"""

import argparse
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lunar.config import BACKEND_DIR, MOON_RADIUS_M  # noqa: E402
from lunar.dem import load_available  # noqa: E402
from lunar.horizon import DEFAULT_MAX_RANGE_M, horizon_ray, side_view, visible_mask  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--lat", type=float, required=True)
    parser.add_argument("--lon", type=float, required=True, help="east-positive degrees")
    parser.add_argument("--az", type=float, required=True, help="compass azimuth, degrees clockwise from north")
    parser.add_argument("--height", type=float, nargs="+", default=[2.0], help="observer height(s) above ground, m")
    parser.add_argument("--max-range-km", type=float, default=DEFAULT_MAX_RANGE_M / 1000)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    products = load_available()
    if not products:
        sys.exit("No elevation maps found. Run: python scripts/fetch_dem.py --tier starter")

    fig, (ax_side, ax_angle) = plt.subplots(2, 1, figsize=(12, 8), constrained_layout=True)
    colors = plt.rcParams["axes.prop_cycle"].by_key()["color"]

    for i, height in enumerate(args.height):
        observer, profile, point = horizon_ray(
            products, args.lat, args.lon, args.az,
            height_above_ground_m=height, max_range_m=args.max_range_km * 1000,
        )
        forward, up = side_view(profile, observer)
        seen = visible_mask(profile)
        km = forward / 1000
        c = colors[i % len(colors)]

        print(
            f"h={height:g} m  site ground {observer.ground_m:.0f} m ({observer.site_pixel_size_m:g} m map) | "
            f"skyline at az {point.azimuth_deg:.2f}: el {point.elevation_deg:+.3f} deg, "
            f"{point.distance_m / 1000:.1f} km away, terrain {point.terrain_m:.0f} m, "
            f"lat {point.lat:.3f} lon {point.lon:.3f}"
            + ("  [WARNING: skyline at max range]" if point.at_max_range else "")
        )

        if i == 0:
            ax_side.fill_between(km, up, up.min() - 500, color="0.85", label="terrain (hidden)")
            ax_side.scatter(km[seen], up[seen], s=3, color="0.2", label="terrain visible from eye", zorder=3)
            # The smooth sphere at the site's height, for comparison.
            delta = profile.distance_m / MOON_RADIUS_M
            smooth_up = (MOON_RADIUS_M + observer.ground_m) * np.cos(delta) - (MOON_RADIUS_M + observer.eye_m)
            ax_side.plot(km, smooth_up, ":", color="0.5", label="smooth sphere through the site")
            ax_side.axhline(0, color="0.6", lw=0.8)

            ax_angle.plot(profile.distance_m / 1000, profile.elevation_deg, color="0.3", lw=1,
                          label="elevation angle of terrain sample")
            ax_angle.axhline(0, color="0.6", lw=0.8)

        sky_x = np.interp(point.distance_m, profile.distance_m, km)
        sky_up = np.interp(point.distance_m, profile.distance_m, up)
        ax_side.plot([0, sky_x], [0, sky_up], "--", color=c, lw=1.2,
                     label=f"line of sight to skyline (h={height:g} m)")
        ax_side.plot(sky_x, sky_up, "o", color=c)
        ax_angle.plot(point.distance_m / 1000, point.elevation_deg, "o", color=c,
                      label=f"skyline h={height:g} m: {point.elevation_deg:+.3f} deg at {point.distance_m / 1000:.1f} km")

    ax_side.plot(0, 0, "^", color="k", ms=8, label="observer eye")
    ax_side.set_title(f"Cross-section from lat {args.lat}, lon {args.lon}, looking azimuth {args.az} deg")
    ax_side.set_xlabel("distance ahead (km)")
    ax_side.set_ylabel("height relative to eye's horizontal plane (m)")
    ax_side.legend(loc="lower left", fontsize=8)
    ax_angle.set_xlabel("distance along surface (km)")
    ax_angle.set_ylabel("apparent elevation (deg)")
    ax_angle.legend(loc="lower left", fontsize=8)

    out = args.out or BACKEND_DIR / "output" / f"ray_{args.lat}_{args.lon}_az{args.az}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=130)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
