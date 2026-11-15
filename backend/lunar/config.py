"""Shared constants and settings."""

import os
from pathlib import Path

# Mean lunar radius used by LOLA products and JPL Horizons (km -> m).
MOON_RADIUS_M = 1_737_400.0

BACKEND_DIR = Path(__file__).resolve().parent.parent

# Where downloaded elevation maps live. Kept out of git (see .gitignore).
DEM_DIR = Path(os.environ.get("LUNAR_DEM_DIR", BACKEND_DIR / "data" / "dem"))
