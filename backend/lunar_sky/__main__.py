"""CLI: python -m lunar_sky LAT LON_EAST ELEV_M TIMESTAMP_UTC"""
import argparse
import json
import sys

from .positions import calculate_positions


def main(argv=None):
    p = argparse.ArgumentParser(prog="lunar_sky", description=__doc__)
    p.add_argument("latitude_deg", type=float, help="planetocentric latitude, degrees")
    p.add_argument("longitude_deg_east", type=float, help="east-positive longitude, degrees")
    p.add_argument("elevation_m", type=float, help="metres above the 1737.4 km sphere")
    p.add_argument("timestamp_utc", help="ISO 8601 UTC, e.g. 2027-03-14T12:00:00Z")
    a = p.parse_args(argv)
    try:
        res = calculate_positions(a.latitude_deg, a.longitude_deg_east, a.elevation_m, a.timestamp_utc)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    print(json.dumps(res, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
