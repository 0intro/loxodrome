#!/usr/bin/env python3
"""The oracle internal/grib2 is pinned against on real feed files.

  grib_oracle.py <file.grib2>  > <file.grib2>.oracle.jsonl

One JSON line per field, in file order:
  offset          the message's byte offset
  samples_sha256  SHA-256 of the packed integers (uint32 little-endian),
                  decoded by libaec itself (template 5.42) or by numpy
                  (template 5.0) from a section walk independent of Go's
  values_sha256   SHA-256 of GDAL's decoded values as float32
                  little-endian, north row first, NaN (0x7fc00000) where
                  the bitmap has no value
  valid, sum      GDAL's count of points with a value and their sum
  probe           GDAL's values at every 9973rd point (null for no value)

Run with python3 -I. Needs libaec, numpy and GDAL's Python bindings
(Fedora: libaec python3-gdal).
"""
import ctypes
import hashlib
import json
import os
import struct
import sys

import numpy as np
from osgeo import gdal

gdal.UseExceptions()
# GDAL turns temperatures from kelvin into degrees Celsius unless told not
# to; the oracle states the file's own values.
gdal.SetConfigOption("GRIB_NORMALIZE_UNITS", "NO")
lib = ctypes.CDLL("libaec.so.0")


class Stream(ctypes.Structure):
    _fields_ = [
        ("next_in", ctypes.c_void_p), ("avail_in", ctypes.c_size_t), ("total_in", ctypes.c_size_t),
        ("next_out", ctypes.c_void_p), ("avail_out", ctypes.c_size_t), ("total_out", ctypes.c_size_t),
        ("bits_per_sample", ctypes.c_uint), ("block_size", ctypes.c_uint), ("rsi", ctypes.c_uint),
        ("flags", ctypes.c_uint), ("state", ctypes.c_void_p),
    ]


def aec_samples(data, n, bits, flags, block, rsi):
    nb = 1 if bits <= 8 else 2 if bits <= 16 else 3 if (bits <= 24 and flags & 2) else 4
    src = ctypes.create_string_buffer(bytes(data), len(data))
    dst = ctypes.create_string_buffer(n * nb)
    s = Stream()
    s.next_in, s.avail_in = ctypes.cast(src, ctypes.c_void_p), len(data)
    s.next_out, s.avail_out = ctypes.cast(dst, ctypes.c_void_p), n * nb
    s.bits_per_sample, s.block_size, s.rsi, s.flags = bits, block, rsi, flags
    rc = lib.aec_buffer_decode(ctypes.byref(s))
    if rc != 0 or s.total_out != n * nb:
        raise RuntimeError(f"libaec rc {rc}, {s.total_out} of {n * nb} bytes")
    raw = np.frombuffer(dst.raw, dtype=np.uint8).reshape(n, nb).astype(np.uint32)
    if flags & 4:  # most significant byte first
        out = np.zeros(n, dtype=np.uint32)
        for k in range(nb):
            out = (out << 8) | raw[:, k]
    else:
        out = np.zeros(n, dtype=np.uint32)
        for k in reversed(range(nb)):
            out = (out << 8) | raw[:, k]
    return out


def simple_samples(data, n, bits):
    bitsarr = np.unpackbits(np.frombuffer(bytes(data), dtype=np.uint8))[: n * bits].reshape(n, bits)
    weights = (1 << np.arange(bits - 1, -1, -1, dtype=np.uint64)).astype(np.uint64)
    return (bitsarr.astype(np.uint64) @ weights).astype(np.uint32)


def sm(v, nbytes):
    sign = 1 << (8 * nbytes - 1)
    return -(v & (sign - 1)) if v & sign else v


def fields(path):
    """Yields (offset, samples) per field, walking sections independently."""
    with open(path, "rb") as f:
        off = 0
        while True:
            head = f.read(16)
            if len(head) < 16:
                return
            assert head[:4] == b"GRIB", off
            total = struct.unpack(">Q", head[8:16])[0]
            msg = head + f.read(total - 16)
            p = 16
            sec5 = None
            while p < total - 4:
                n, num = struct.unpack(">IB", msg[p : p + 5])
                s = msg[p : p + n]
                if num == 5:
                    sec5 = s
                elif num == 7:
                    npk = struct.unpack(">I", sec5[5:9])[0]
                    drt = struct.unpack(">H", sec5[9:11])[0]
                    bits = sec5[19]
                    data = s[5:]
                    if bits == 0:
                        samples = np.zeros(npk, dtype=np.uint32)
                    elif drt == 42:
                        flags, block = sec5[21], sec5[22]
                        rsi = struct.unpack(">H", sec5[23:25])[0]
                        samples = aec_samples(data, npk, bits, flags, block, rsi)
                    elif drt == 0:
                        samples = simple_samples(data, npk, bits)
                    else:
                        raise RuntimeError(f"template 5.{drt}")
                    yield off, samples
                p += n
            off += total


def main(path):
    ds = gdal.Open(path)
    out = sys.stdout
    for k, (off, samples) in enumerate(fields(path)):
        band = ds.GetRasterBand(k + 1)
        arr = band.ReadAsArray().astype(np.float64)
        nodata = band.GetNoDataValue()
        mask = np.isnan(arr)
        if nodata is not None:
            mask |= arr == nodata
        flat = arr.reshape(-1)
        f32 = flat.astype(np.float32)
        f32[mask.reshape(-1)] = np.float32("nan")
        bits = f32.view(np.uint32).copy()
        bits[mask.reshape(-1)] = 0x7FC00000
        probe = [None if mask.reshape(-1)[i] else float(f32[i]) for i in range(0, flat.size, 9973)]
        rec = {
            "offset": off,
            "samples_sha256": hashlib.sha256(samples.astype("<u4").tobytes()).hexdigest(),
            "values_sha256": hashlib.sha256(bits.astype("<u4").tobytes()).hexdigest(),
            "valid": int((~mask).sum()),
            "sum": float(flat[~mask.reshape(-1)].sum()),
            "probe": probe,
        }
        out.write(json.dumps(rec) + "\n")
    if ds.RasterCount != k + 1:
        raise RuntimeError(f"GDAL sees {ds.RasterCount} bands, the walk {k + 1} fields")


if __name__ == "__main__":
    main(sys.argv[1])
