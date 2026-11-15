"""Minimal reader for PDS3 label (.lbl) files.

Each LOLA elevation map ships with a plain-text label describing its size,
data type and map projection, e.g.

    OBJECT = IMAGE
      LINES        = 3812
      SAMPLE_TYPE  = PC_REAL
    END_OBJECT = IMAGE
    OBJECT = IMAGE_MAP_PROJECTION
      MAP_SCALE    = 240 <m/pix>
    END_OBJECT = IMAGE_MAP_PROJECTION

`parse_label` turns that into nested dicts:
    label["IMAGE"]["LINES"] == 3812
    label["IMAGE_MAP_PROJECTION"]["MAP_SCALE"] == 240.0

Only what we need is supported: KEY = VALUE pairs, OBJECT nesting, comments,
quoted or braced values spanning several lines, and trailing <unit> tags
(units are dropped; the code documents which unit each field uses).
"""

import re
from pathlib import Path

_UNIT = re.compile(r"\s*<[^>]*>\s*$")
_INT = re.compile(r"^[+-]?\d+$")
_FLOAT = re.compile(r"^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$")


def parse_value(raw: str):
    """Convert one raw PDS value string to int, float or str."""
    value = _UNIT.sub("", raw.strip())
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1].strip()
    if _INT.match(value):
        return int(value)
    if _FLOAT.match(value):
        return float(value)
    return value


def _is_complete(value: str) -> bool:
    """True once quotes and braces in a (possibly multi-line) value are closed."""
    return value.count('"') % 2 == 0 and value.count("{") == value.count("}")


def parse_label(text: str) -> dict:
    """Parse PDS3 label text into nested dicts keyed by OBJECT name."""
    root: dict = {}
    stack = [root]
    pending_key = None
    pending_value = ""

    for line in text.splitlines():
        if pending_key is not None:  # continuing a multi-line value
            pending_value += "\n" + line
            if _is_complete(pending_value):
                stack[-1][pending_key] = parse_value(pending_value)
                pending_key = None
            continue

        stripped = line.strip()
        if not stripped or stripped.startswith("/*") or stripped == "END":
            continue
        if "=" not in stripped:
            continue

        key, raw = (part.strip() for part in stripped.split("=", 1))
        if key == "OBJECT":
            child: dict = {}
            stack[-1][raw] = child
            stack.append(child)
        elif key == "END_OBJECT":
            if len(stack) > 1:
                stack.pop()
        elif _is_complete(raw):
            stack[-1][key] = parse_value(raw)
        else:
            pending_key, pending_value = key, raw

    return root


def read_label(path: Path) -> dict:
    """Read and parse a .lbl file."""
    return parse_label(Path(path).read_text(encoding="latin-1"))


def find_object(label: dict, name: str) -> dict:
    """Return the first OBJECT called `name`, searching nested objects too."""
    if name in label and isinstance(label[name], dict):
        return label[name]
    for value in label.values():
        if isinstance(value, dict):
            try:
                return find_object(value, name)
            except KeyError:
                pass
    raise KeyError(f"OBJECT {name!r} not found in label")
