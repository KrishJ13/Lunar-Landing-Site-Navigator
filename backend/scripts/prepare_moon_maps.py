"""Convert NASA SVS and LOLA rasters into browser textures for Moon Explorer."""

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lunar.dem.product import DemProduct  # noqa: E402


def save_elevations(product, output, max_width):
    # Encode height to half-metre precision, offset by 12 km. Lossless WebP
    # preserves the two bytes. The shader interpolates the decoded heights.
    height = np.asarray(product.data) * product.km_scale * 1000
    if not np.isfinite(height).all() or height.min() < -12000 or height.max() > 20767:
        raise ValueError(f"{product.name}: invalid or unencodable elevation")
    raster = Image.fromarray(height)
    if raster.width > max_width:
        new_height = round(raster.height * max_width / raster.width)
        raster = raster.resize((max_width, new_height), Image.Resampling.LANCZOS)
    encoded = np.rint((np.asarray(raster) + 12000) * 2).astype(np.uint16)
    rgb = np.zeros((*encoded.shape, 3), dtype=np.uint8)
    rgb[:, :, 0] = encoded >> 8
    rgb[:, :, 1] = encoded & 255
    Image.fromarray(rgb).save(output, lossless=True, method=4)
    # Return a UV transform using the original PDS pixel-centre convention.
    lines, samples = product.shape
    p = product.projection
    if hasattr(p, "pixels_per_degree"):
        return {
            "offset": [(p.sample_offset + 0.5) / samples, (p.line_offset + 0.5) / lines],
            "scale": [p.pixels_per_degree / samples, -p.pixels_per_degree / lines],
            "center": [p.center_lon, p.center_lat],
            "west": p.west_lon,
        }
    return {
        "offset": [(p.sample_offset + 0.5) / samples, (p.line_offset + 0.5) / lines],
        "scale": [1 / (samples * p.meters_per_pixel), 1 / (lines * p.meters_per_pixel)],
    }


def main():
    import json

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("color_tiff", type=Path)
    parser.add_argument("dem_directory", type=Path)
    parser.add_argument("output_directory", type=Path)
    args = parser.parse_args()
    args.output_directory.mkdir(parents=True, exist_ok=True)
    specs = {}
    for name, product_name, width in (
        ("global", "ldem_16", 4096),
        ("north", "ldem_75n_240m", 2048),
        ("south", "ldem_75s_240m", 2048),
    ):
        product = DemProduct.open(args.dem_directory / f"{product_name}_float.lbl")
        specs[name] = save_elevations(product, args.output_directory / f"{name}.webp", width)
    (args.output_directory / "projections.json").write_text(json.dumps(specs, indent=2) + "\n")
    with Image.open(args.color_tiff) as image:
        color = image.convert("RGB")
        color.resize((2048, 1024), Image.Resampling.LANCZOS).save(
            args.output_directory / "moon.webp", quality=89, method=5
        )
        color.save(args.output_directory / "moon-8k.webp", quality=86, method=5)


if __name__ == "__main__":
    main()
