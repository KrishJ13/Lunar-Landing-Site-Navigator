import numpy as np
import pytest

from lunar.dem import DemProduct, best_product, height_at


class TestCylindricalProduct:
    def test_reads_label_and_shape(self, make_cylindrical):
        product = DemProduct.open(make_cylindrical(lambda lat, lon: 0 * lat, ppd=4))
        assert product.shape == (720, 1440)
        assert product.pixel_size_m == pytest.approx(7581.3, rel=1e-3)

    def test_height_at_pixel_centre_is_exact(self, make_cylindrical):
        product = DemProduct.open(make_cylindrical(lambda lat, lon: lat / 100 + lon / 1000))
        # pixel centre at lat 10.125, lon 20.125 (ppd = 4)
        expected_km = 10.125 / 100 + 20.125 / 1000
        assert product.height_m(10.125, 20.125) == pytest.approx(expected_km * 1000, abs=1e-3)

    def test_bilinear_reproduces_a_plane(self, make_cylindrical):
        product = DemProduct.open(make_cylindrical(lambda lat, lon: 0.02 * lat - 0.003 * lon))
        lat = np.array([-30.3, 5.01, 44.44])
        lon = np.array([10.7, 123.456, 200.2])
        np.testing.assert_allclose(product.heights_m(lat, lon), (0.02 * lat - 0.003 * lon) * 1000, atol=1e-2)

    def test_interpolates_across_the_0_360_seam(self, make_cylindrical):
        # Height depends on cos(lon), which is smooth across the seam.
        product = DemProduct.open(make_cylindrical(lambda lat, lon: np.cos(np.radians(lon))))
        assert product.height_m(0.125, 359.99) == pytest.approx(product.height_m(0.125, -0.01))
        assert product.height_m(0.125, 0.0) == pytest.approx(1000.0, abs=0.1)

    def test_global_map_covers_everywhere_including_poles(self, make_cylindrical):
        product = DemProduct.open(make_cylindrical(lambda lat, lon: 0 * lat))
        assert product.contains(np.array([90, -90, 0]), np.array([0, 180, 359.9])).all()
        assert np.isfinite(product.heights_m([90, -90], [0, 0])).all()


class TestPolarProduct:
    def test_bilinear_reproduces_a_plane(self, make_polar):
        product = DemProduct.open(make_polar(lambda x, y: 1e-6 * x - 2e-6 * y))
        assert product.pixel_size_m == 1000.0
        # Points near the pole with known map-plane x, y.
        lat, lon = product.projection.pixel_to_latlon(np.array([40.3, 55.7]), np.array([61.2, 47.9]))
        x = (np.array([61.2, 47.9]) - 50) * 1000
        y = (50 - np.array([40.3, 55.7])) * 1000
        np.testing.assert_allclose(product.heights_m(lat, lon), (1e-6 * x - 2e-6 * y) * 1000, atol=1e-3)

    def test_orientation_lon90_is_to_the_right(self, make_polar):
        # Height = x (metres right of pole) / 1e6 km, so +ve only on the right.
        product = DemProduct.open(make_polar(lambda x, y: x / 1e6))
        assert product.height_m(-89.5, 90) > 0
        assert product.height_m(-89.5, 270) < 0
        assert product.height_m(-89.5, 0) == pytest.approx(0, abs=1e-6)

    def test_outside_coverage_is_nan(self, make_polar):
        product = DemProduct.open(make_polar(lambda x, y: 0 * x))  # ~50 km around the pole
        assert not product.contains(-80, 0)
        assert np.isnan(product.height_m(-80, 0))
        assert product.contains(-89.9, 0)


class TestCatalogHelpers:
    def test_best_product_prefers_finest_covering_map(self, make_cylindrical, make_polar):
        coarse = DemProduct.open(make_cylindrical(lambda lat, lon: 0 * lat + 1.0))  # 1 km everywhere
        fine = DemProduct.open(make_polar(lambda x, y: 0 * x + 2.0))  # 2 km near the pole
        products = [coarse, fine]
        assert best_product(products, -89.9, 10) is fine
        assert best_product(products, -60, 10) is coarse
        assert height_at(products, -89.9, 10) == pytest.approx(2000)
        assert height_at(products, 0, 10) == pytest.approx(1000)

    def test_no_covering_map_raises(self, make_polar):
        fine = DemProduct.open(make_polar(lambda x, y: 0 * x))
        with pytest.raises(LookupError):
            best_product([fine], 0, 0)


def test_rejects_truncated_download(make_cylindrical):
    label = make_cylindrical(lambda lat, lon: 0 * lat)
    img = label.with_suffix(".img")
    img.write_bytes(img.read_bytes()[:-4])
    with pytest.raises(ValueError, match="incomplete download"):
        DemProduct.open(label)
