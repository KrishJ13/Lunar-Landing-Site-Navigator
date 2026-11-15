"""Binary payload for POST /api/site/terrain.

Mesh arrays are large (hundreds of thousands of vertices), so they travel as
raw little-endian arrays rather than JSON numbers:

    bytes 0-3    magic b"LTER"
    bytes 4-7    uint32 format version (1)
    bytes 8-11   uint32 header length H
    bytes 12..   H bytes of UTF-8 JSON header
    padding      zero bytes up to a multiple of 8
    buffers      each at header["buffers"][i]["offset"] (from the start of the
                 payload, 8-byte aligned), dtype and shape as listed; C order

A browser reads a buffer with e.g. new Float32Array(payload, offset, count).
"""

import json
import struct

import numpy as np

MAGIC = b"LTER"
VERSION = 1


def encode(header: dict, arrays: dict[str, np.ndarray]) -> bytes:
    buffers, blobs = [], []
    pending = {name: np.ascontiguousarray(a) for name, a in arrays.items()}
    # Offsets depend on the header length, which depends on the offsets: lay out
    # the buffers relative to the data start, then add the start once it is known.
    rel = 0
    for name, a in pending.items():
        dtype = a.dtype.newbyteorder("<") if a.dtype.byteorder == ">" else a.dtype
        blob = a.astype(dtype, copy=False).tobytes()
        buffers.append({"name": name, "dtype": dtype.str.lstrip("<|="), "shape": list(a.shape),
                        "offset": rel, "byte_length": len(blob)})
        blobs.append(blob + b"\0" * (-len(blob) % 8))
        rel += len(blobs[-1])
    for width in range(1, 10):  # data start, padded to 8; iterate until the header fits
        start = 8 * width * 1024
        full = dict(header, buffers=[dict(b, offset=b["offset"] + start) for b in buffers])
        text = json.dumps(full, separators=(",", ":")).encode()
        if 12 + len(text) <= start:
            break
    else:  # pragma: no cover
        raise ValueError("header too large")
    head = MAGIC + struct.pack("<II", VERSION, len(text)) + text
    return head + b"\0" * (start - len(head)) + b"".join(blobs)


def decode(payload: bytes) -> tuple[dict, dict[str, np.ndarray]]:
    if payload[:4] != MAGIC:
        raise ValueError("not a terrain payload")
    version, length = struct.unpack("<II", payload[4:12])
    if version != VERSION:
        raise ValueError(f"unsupported terrain payload version {version}")
    header = json.loads(payload[12:12 + length])
    arrays = {}
    for b in header["buffers"]:
        dtype = np.dtype("<" + b["dtype"]) if b["dtype"][0] in "fiu" else np.dtype(b["dtype"])
        count = int(np.prod(b["shape"])) if b["shape"] else 1
        arrays[b["name"]] = np.frombuffer(payload, dtype=dtype, count=count, offset=b["offset"]).reshape(b["shape"])
    return header, arrays
