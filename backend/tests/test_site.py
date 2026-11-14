"""Site description tests on synthetic terrain."""

import numpy as np
import pytest

from lunar.dem import DemProduct
from lunar.site import describe_site


def _moon(make_cylindrical, make_polar, polar_fn):
    """Smooth background plus a polar map (x, y in metres -> km) near the south pole."""
    return [
        DemProduct.open(make_cylindrical(lambda lat, lon: 0 * lat)),
        DemProduct.open(make_polar(polar_fn, n=201, scale_m=250.0)),
    ]


def test_flat_ground(make_cylindrical, make_polar):
    info = describe_site(_moon(make_cylindrical, make_polar, lambda x, y: 0 * x), -90, 0)
    assert info.ground_m == pytest.approx(0)
    assert info.slope_deg == pytest.approx(0, abs=1e-6)
    assert info.aspect_deg is None
    assert info.setting.startswith("open")
    assert [s.radius_m for s in info.surroundings] == [1_000, 10_000]


def test_bowl_is_low_ground(make_cylindrical, make_polar):
    # Paraboloid bowl centred on the pole: rises 1 km at 10 km radius.
    info = describe_site(_moon(make_cylindrical, make_polar, lambda x, y: (x**2 + y**2) / 1e8), -90, 0)
    assert info.ground_m == pytest.approx(0, abs=5)  # bilinear on a curved surface: small error
    wide = info.surroundings[-1]
    assert wide.max_m == pytest.approx(1000, rel=0.02)
    assert wide.fraction_lower == 0.0
    assert info.setting.startswith("low ground")


def test_cone_is_high_ground(make_cylindrical, make_polar):
    info = describe_site(_moon(make_cylindrical, make_polar, lambda x, y: 2.0 - np.hypot(x, y) / 1e4), -90, 0)
    assert info.ground_m == pytest.approx(2000, abs=20)
    assert info.surroundings[-1].fraction_lower == 1.0
    assert info.setting.startswith("high ground")


def test_slope_and_aspect(make_cylindrical, make_polar):
    # Ground rises 1 m per 100 m towards map-x (longitude 90E). At (89.9S, 90E),
    # map-x is local north, so the slope faces SOUTH (downhill), aspect 180.
    info = describe_site(_moon(make_cylindrical, make_polar, lambda x, y: x * 1e-5), -89.9, 90.0)
    assert info.slope_deg == pytest.approx(np.degrees(np.arctan(0.01)), abs=0.01)
    assert info.aspect_deg == pytest.approx(180.0, abs=0.5)
