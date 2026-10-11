#!/usr/bin/env python3
"""libaec through ctypes: the oracle internal/aec is pinned against.

  libaec_oracle.py vectors <dir>
      writes vectors.json and the coded streams of a spread of synthetic
      cases (every flag, every identifier length, every option), each
      encoded AND decoded by libaec, the decoded samples kept as a SHA-256
      over uint32 little-endian values (two's complement widened for
      signed data), which is how the Go test states them.

  libaec_oracle.py decode <bits> <block> <rsi> <flags> <n> < stream > samples
      decodes one stream to n uint32 little-endian samples (the corpus
      test's oracle for real GRIB2 messages).

Run with python3 -I. Needs libaec (Fedora: libaec) and numpy.
"""
import ctypes
import hashlib
import json
import os
import sys

import numpy as np

lib = ctypes.CDLL("libaec.so.0")
# libaec's encoder pads an interval to a byte boundary only when built with
# ENABLE_RSI_PADDING, which no build option sets, while its decoder always
# honours AEC_PAD_RSI: PAD_RSI vectors need such a build (gcc -shared -fPIC
# -DENABLE_RSI_PADDING over encode.c encode_accessors.c decode.c vector.c of
# the same release), named by LIBAEC_PAD.
padlib = ctypes.CDLL(os.environ["LIBAEC_PAD"]) if os.environ.get("LIBAEC_PAD") else None


class Stream(ctypes.Structure):
    _fields_ = [
        ("next_in", ctypes.c_void_p),
        ("avail_in", ctypes.c_size_t),
        ("total_in", ctypes.c_size_t),
        ("next_out", ctypes.c_void_p),
        ("avail_out", ctypes.c_size_t),
        ("total_out", ctypes.c_size_t),
        ("bits_per_sample", ctypes.c_uint),
        ("block_size", ctypes.c_uint),
        ("rsi", ctypes.c_uint),
        ("flags", ctypes.c_uint),
        ("state", ctypes.c_void_p),
    ]


SIGNED, THREE, MSB, PP, RESTRICTED, PAD, NOT_ENFORCE = 1, 2, 4, 8, 16, 32, 64


def sample_bytes(bits, flags):
    if bits <= 8:
        return 1
    if bits <= 16:
        return 2
    if bits <= 24 and flags & THREE:
        return 3
    return 4


def run(fn, data, out_size, bits, block, rsi, flags, strict=True):
    src = ctypes.create_string_buffer(bytes(data), len(data))
    dst = ctypes.create_string_buffer(out_size)
    s = Stream()
    s.next_in = ctypes.cast(src, ctypes.c_void_p)
    s.avail_in = len(data)
    s.next_out = ctypes.cast(dst, ctypes.c_void_p)
    s.avail_out = out_size
    s.bits_per_sample, s.block_size, s.rsi, s.flags = bits, block, rsi, flags
    rc = fn(ctypes.byref(s))
    # libaec 1.1.4's decoder answers AEC_DATA_ERROR after filling the
    # output when PAD_RSI leaves padding bits it reads as a further block;
    # the samples are all there, so only a short output is a failure.
    if rc != 0 and (strict or s.total_out != out_size):
        raise RuntimeError(f"libaec returned {rc}")
    return dst.raw[: s.total_out]


def to_bytes(values, bits, flags):
    nb = sample_bytes(bits, flags)
    order = "big" if flags & MSB else "little"
    # libaec's encoder sign-extends a signed sample from its n bits itself
    # (x ^ m) - m, which only holds when the bits above n are zero.
    mask = (1 << bits) - 1
    return b"".join((int(v) & mask).to_bytes(nb, order) for v in values)


def from_bytes(raw, bits, flags):
    nb = sample_bytes(bits, flags)
    order = "big" if flags & MSB else "little"
    out = []
    for i in range(0, len(raw), nb):
        v = int.from_bytes(raw[i : i + nb], order)
        if flags & SIGNED:
            m = 1 << (bits - 1)
            v &= (1 << bits) - 1
            v = (v ^ m) - m
        out.append(v & 0xFFFFFFFF)
    return out


def u32le(values):
    return np.asarray(values, dtype=np.uint32).astype("<u4").tobytes()


def make_samples(rng, kind, n, bits, signed):
    lo = -(1 << (bits - 1)) if signed else 0
    hi = (1 << (bits - 1)) - 1 if signed else (1 << bits) - 1
    if kind == "zeros":
        v = np.zeros(n, dtype=np.int64)
    elif kind == "constant":
        v = np.full(n, rng.integers(lo, hi + 1), dtype=np.int64)
    elif kind == "random":
        v = rng.integers(lo, hi + 1, size=n, dtype=np.int64)
    elif kind == "smooth":
        # A slowly wandering signal: the small residuals the predictor makes.
        steps = rng.integers(-2, 3, size=n)
        v = np.cumsum(steps) + (lo + hi) // 2
    elif kind == "edges":
        # Values hugging both ends of the range: the folding's far branches.
        v = np.where(rng.random(n) < 0.5, lo + rng.integers(0, 3, size=n), hi - rng.integers(0, 3, size=n))
    elif kind == "sparse":
        # Mostly zeros, with bursts: zero-block runs and their end of segment.
        v = np.zeros(n, dtype=np.int64)
        idx = rng.choice(n, size=max(1, n // 50), replace=False)
        v[idx] = rng.integers(lo, hi + 1, size=len(idx))
    elif kind == "small":
        # Pairs summing under 13: the second extension's ground.
        v = rng.integers(0, 4, size=n) + (lo if signed else 0)
    else:
        raise ValueError(kind)
    return np.clip(v, lo, hi)


def vectors(outdir):
    rng = np.random.default_rng(20261006)
    os.makedirs(outdir, exist_ok=True)
    cases = []
    combos = []
    for bits in (1, 2, 3, 4, 5, 7, 8, 9, 12, 13, 15, 16, 17, 20, 24, 25, 31, 32):
        for flags in (0, PP, PP | MSB, PP | SIGNED, SIGNED, PP | PAD, PP | MSB | THREE):
            combos.append((bits, flags))
    for bits in (1, 2, 3, 4):
        combos.append((bits, PP | RESTRICTED))
        combos.append((bits, RESTRICTED))
    for i, (bits, flags) in enumerate(combos):
        block = (8, 16, 32, 64)[i % 4]
        rsi = (1, 2, 7, 64, 128)[i % 5]
        if i % 11 == 0:
            flags |= NOT_ENFORCE
            block = (10, 24, 6)[i % 3]
        kind = ("zeros", "constant", "random", "smooth", "edges", "sparse", "small")[i % 7]
        n = int(rng.integers(1, 1500)) if i % 3 else int(rng.integers(1500, 5000))
        if bits > 16:
            n = min(n, 1200)  # wide random samples do not compress: keep the files small
        samples = make_samples(rng, kind, n, bits, bool(flags & SIGNED))
        raw = to_bytes(samples, bits, flags)
        codec = lib
        if flags & PAD:
            if padlib is None:
                sys.exit("PAD_RSI vectors need LIBAEC_PAD (see the top of this file)")
            codec = padlib
        enc = run(codec.aec_buffer_encode, raw, len(raw) * 2 + 4096, bits, block, rsi, flags)
        want = from_bytes(raw, bits, flags)
        dec = run(lib.aec_buffer_decode, enc, len(raw), bits, block, rsi, flags, strict=False)
        if from_bytes(dec, bits, flags) != want:
            raise RuntimeError(f"libaec round trip failed for case {i}")
        name = f"case{i:03d}.aec"
        with open(os.path.join(outdir, name), "wb") as f:
            f.write(enc)
        cases.append({
            "file": name, "bits": bits, "block": block, "rsi": rsi,
            "flags": flags, "n": n, "kind": kind,
            "sha256": hashlib.sha256(u32le(want)).hexdigest(),
        })
    with open(os.path.join(outdir, "vectors.json"), "w") as f:
        json.dump({"libaec": "1.1.4", "cases": cases}, f, indent=1)
        f.write("\n")


def decode(bits, block, rsi, flags, n):
    data = sys.stdin.buffer.read()
    nb = sample_bytes(bits, flags)
    dec = run(lib.aec_buffer_decode, data, n * nb, bits, block, rsi, flags, strict=False)
    if len(dec) != n * nb:
        raise RuntimeError(f"libaec decoded {len(dec)} bytes, {n * nb} wanted")
    sys.stdout.buffer.write(u32le(from_bytes(dec, bits, flags)))


if __name__ == "__main__":
    if sys.argv[1] == "vectors":
        vectors(sys.argv[2])
    elif sys.argv[1] == "decode":
        decode(*(int(a) for a in sys.argv[2:7]))
    else:
        sys.exit(__doc__)
