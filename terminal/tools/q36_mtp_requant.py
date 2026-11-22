"""tools/q36_mtp_requant.py - make a Qwen3.6-35B-A3B GGUF whose MTP block the engine cannot load runnable.

Unsloth's low-bit Qwen3.6 files (unsloth/Qwen3.6-35B-A3B-MTP-GGUF, UD-IQ3_S and below) store the MTP block's routed
experts (blk.40) as Q2_K / Q3_K / Q4_K.  The engine's GPU expert kernels take neither Q2_K / Q3_K experts nor Q4_K
down projections (STRATA_GU_FMTS / STRATA_D_FMTS in src/kernels/cuda/iq_kernels.cu), and it loads the MTP block
whenever the file has one, so it refuses the whole file at start ("experts are Q2_K/Q4_K, which the native expert
kernels do not take").

This tool rewrites only those MTP-block expert tensors: gate / up as Q4_K (dequantized and quantized again) and down
as Q5_K (a Q4_K down is copied into it exactly; Q5_K is Q4_K with one more bit, left 0).  Every other tensor and every metadata entry is copied byte for byte; one entry,
strata.q36.mtp_requant, records what was changed.  The MTP block only proposes draft tokens that the main model then
checks, so a greedy answer is the main model's either way.

    python tools/q36_mtp_requant.py --check FILE.gguf
    python tools/q36_mtp_requant.py FILE.gguf OUT.gguf

--check says whether the engine takes the file as it is, needs this conversion, or cannot run it (main layers in types
the engine has no kernels for; this tool does not touch the main layers, since that would change the answers).
"""
from __future__ import annotations

import argparse
import os
import pathlib
import re
import struct
import sys
import time

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from gguf_reader import BLOCK_GEOMETRY, GGML_TYPES, GGUFFile  # noqa: E402

# The expert types the engine's GPU kernels take (src/kernels/cuda/iq_kernels.cu, STRATA_GU_FMTS / STRATA_D_FMTS with
# STRATA_Q6K_EXPERTS=ON, the default).  The engine checks every layer against these, the MTP block included.
ENGINE_GU = {16, 17, 18, 21, 22, 23, 29, 42, 12, 13, 14, 6, 2, 3, 8, 40, 144, 145, 147, 148, 149}
ENGINE_D = {20, 23, 42, 7, 6, 2, 3, 8, 13, 14, 40, 144, 146, 147, 148, 149}
Q8_0, Q4_K, Q5_K = 8, 12, 13
CONVERTIBLE = {10, 11, 12, 13, 8}      # Q2_K, Q3_K, Q4_K, Q5_K and Q8_0 have a dequantizer here
# what the MTP block's experts become: gate / up Q4_K, down Q5_K (a Q4_K down is copied into it exactly).  Compact on
# purpose: the engine's prompt path keeps two staging copies of its largest layer's experts in VRAM, and an MTP block in
# Q8_0 (816 MiB) was that layer, twice the main layers' (<= 392 MiB in UD-IQ3_S); as Q4_K / Q5_K it is 475 MiB.
TARGET = {"gate": Q4_K, "up": Q4_K, "down": Q5_K}
TARGET_Q8 = {"gate": Q8_0, "up": Q8_0, "down": Q8_0}   # --mtp-format q8_0: the first form (what setup pins)
EXPERT_RE = re.compile(r"^blk\.(\d+)\.ffn_(gate|up|down)_exps\.weight$")
CHUNK = 64 << 20


# --------------------------------------------------------------------------------------------- dequantizers (ggml)
def _f16(raw: np.ndarray) -> np.ndarray:
    """(n, 2) uint8 -> (n,) float32 from IEEE binary16."""
    return np.ascontiguousarray(raw).view("<f2").reshape(-1).astype(np.float32)


def dequant_q2_k(raw: np.ndarray) -> np.ndarray:
    """Q2_K blocks (n, 84): scales[16] (low nibble scale, high nibble min), qs[64], d, dmin -> (n, 256) float32.
    ggml-quants.c dequantize_row_q2_K: value [h*128 + j*32 + p*16 + l] = d*(sc&15)*((qs[h*32+p*16+l] >> 2j) & 3)
    - dmin*(sc>>4), sc = scales[h*8 + j*2 + p]."""
    b = raw.reshape(-1, 84)
    sc = b[:, 0:16]
    qs = b[:, 16:80].reshape(-1, 2, 2, 16)                  # [n, h, p, l]
    d = _f16(b[:, 80:82])[:, None]
    dmin = _f16(b[:, 82:84])[:, None]
    shifts = np.arange(4, dtype=np.uint8) * 2                # j
    q = (qs[:, :, None, :, :] >> shifts[None, None, :, None, None]) & 3   # [n, h, j, p, l]
    s = sc.reshape(-1, 2, 4, 2)                              # [n, h, j, p]
    dl = d[:, :, None, None] * (s & 15).astype(np.float32)
    ml = dmin[:, :, None, None] * (s >> 4).astype(np.float32)
    y = dl[..., None] * q.astype(np.float32) - ml[..., None]
    return y.reshape(-1, 256)


def _k4_scales(sc: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """The 8 6-bit scales and mins of a Q4_K / Q5_K block (get_scale_min_k4)."""
    s = sc.astype(np.uint8)
    lo_s = s[:, 0:4] & 63
    lo_m = s[:, 4:8] & 63
    hi_s = (s[:, 8:12] & 15) | ((s[:, 0:4] >> 6) << 4)
    hi_m = (s[:, 8:12] >> 4) | ((s[:, 4:8] >> 6) << 4)
    return np.concatenate([lo_s, hi_s], 1).astype(np.float32), np.concatenate([lo_m, hi_m], 1).astype(np.float32)


def dequant_q4_k(raw: np.ndarray) -> np.ndarray:
    """Q4_K blocks (n, 144): d, dmin, scales[12], qs[128] -> (n, 256) float32 (dequantize_row_q4_K)."""
    b = raw.reshape(-1, 144)
    d = _f16(b[:, 0:2])[:, None]
    dmin = _f16(b[:, 2:4])[:, None]
    sc, mn = _k4_scales(b[:, 4:16])
    qs = b[:, 16:144].reshape(-1, 4, 32)                     # [n, chunk, l]
    q = np.stack([qs & 15, qs >> 4], 2).astype(np.float32)   # [n, chunk, half, l]
    dl = (d * sc).reshape(-1, 4, 2)
    ml = (dmin * mn).reshape(-1, 4, 2)
    y = dl[..., None] * q - ml[..., None]
    return y.reshape(-1, 256)


def dequant_q3_k(raw: np.ndarray) -> np.ndarray:
    """Q3_K blocks (n, 110): hmask[32], qs[64], scales[12], d -> (n, 256) float32 (dequantize_row_q3_K)."""
    b = raw.reshape(-1, 110)
    hm = b[:, 0:32]
    qs = b[:, 32:96].reshape(-1, 2, 2, 16)                  # [n, h, p, l]
    aux = np.ascontiguousarray(b[:, 96:108]).view("<u4").reshape(-1, 3).copy()
    k1, k2 = np.uint32(0x03030303), np.uint32(0x0F0F0F0F)
    tmp = aux[:, 2].copy()
    a0, a1 = aux[:, 0].copy(), aux[:, 1].copy()
    s32 = np.stack([(a0 & k2) | (((tmp >> 0) & k1) << 4),
                    (a1 & k2) | (((tmp >> 2) & k1) << 4),
                    ((a0 >> 4) & k2) | (((tmp >> 4) & k1) << 4),
                    ((a1 >> 4) & k2) | (((tmp >> 6) & k1) << 4)], 1).astype("<u4")
    scales = np.ascontiguousarray(s32).view(np.int8).reshape(-1, 16).astype(np.float32) - 32.0
    d = _f16(b[:, 108:110])[:, None]
    shifts = np.arange(4, dtype=np.uint8) * 2
    q = ((qs[:, :, None, :, :] >> shifts[None, None, :, None, None]) & 3).astype(np.int8)    # [n, h, j, p, l]
    hmr = hm.reshape(-1, 2, 16)                             # [n, p, l] (hmask[p*16 + l])
    bit = (np.arange(2)[:, None] * 4 + np.arange(4)[None, :]).astype(np.uint8)              # [h, j] -> m = 1 << (4h + j)
    high = (hmr[:, None, None, :, :] >> bit[None, :, :, None, None]) & 1                    # [n, h, j, p, l]
    q = q - np.where(high != 0, 0, 4).astype(np.int8)
    dl = d[:, :, None, None] * scales.reshape(-1, 2, 4, 2)
    y = dl[..., None] * q.astype(np.float32)
    return y.reshape(-1, 256)


def dequant_q5_k(raw: np.ndarray) -> np.ndarray:
    """Q5_K blocks (n, 176): d, dmin, scales[12], qh[32], qs[128] -> (n, 256) float32 (dequantize_row_q5_K): chunk c of
    64 values, value [c*64 + l] = d*sc[2c]*((qs[c*32+l] & 15) + 16*bit(qh[l], 2c)) - dmin*m[2c], and [c*64+32+l] the
    high nibble with bit 2c+1."""
    b = raw.reshape(-1, 176)
    d = _f16(b[:, 0:2])[:, None]
    dmin = _f16(b[:, 2:4])[:, None]
    sc, mn = _k4_scales(b[:, 4:16])
    qh = b[:, 16:48]                                         # [n, l]
    qs = b[:, 48:176].reshape(-1, 4, 32)                     # [n, chunk, l]
    bits = np.arange(8, dtype=np.uint8).reshape(4, 2)        # [chunk, half] -> qh bit
    hi = ((qh[:, None, None, :] >> bits[None, :, :, None]) & 1).astype(np.float32) * 16.0   # [n, chunk, half, l]
    q = np.stack([qs & 15, qs >> 4], 2).astype(np.float32) + hi
    dl = (d * sc).reshape(-1, 4, 2)
    ml = (dmin * mn).reshape(-1, 4, 2)
    return (dl[..., None] * q - ml[..., None]).reshape(-1, 256)


def quant_q4_k(x: np.ndarray) -> np.ndarray:
    """float32 values (a multiple of 256) -> Q4_K blocks (n, 144).  Each 32-value sub-block gets the affine range of its
    values (the offset is never above 0, as Q4_K stores it), the super-block's d / dmin are the largest scale / offset over
    63, stored as fp16, and the 6-bit scales and the 4-bit values are rounded against those stored numbers."""
    v = x.reshape(-1, 8, 32).astype(np.float32)
    lo = np.minimum(v.min(2), 0.0)
    off = -lo
    # d / dmin with a little room (the fp16 rounding and the ceilings below must not need a 64th step)
    m16 = (off.max(1) / 62.0).astype("<f2")
    dm = m16.astype(np.float32)[:, None]
    with np.errstate(divide="ignore", invalid="ignore"):
        # the offset rounded up, so no value falls below 0; then the scale rounded up to cover the shifted range, so
        # none goes past 15: every value is within half a step of the scale actually stored
        mn = np.where(dm > 0, np.clip(np.ceil(off / dm), 0, 63), 0).astype(np.uint8)
        top = (v + (dm * mn)[..., None]).max(2)
        scale = top / 15.0
        d16 = (scale.max(1) / 62.0).astype("<f2")
        d = d16.astype(np.float32)[:, None]
        sc = np.where(d > 0, np.clip(np.ceil(scale / d), 0, 63), 0).astype(np.uint8)
        es = (d * sc)[..., None]
        q = np.where(es > 0, np.clip(np.rint((v + (dm * mn)[..., None]) / es), 0, 15), 0).astype(np.uint8)   # [n, 8, 32]
    s = np.zeros((v.shape[0], 12), np.uint8)
    s[:, 0:4] = sc[:, 0:4] | ((sc[:, 4:8] >> 4) << 6)
    s[:, 4:8] = mn[:, 0:4] | ((mn[:, 4:8] >> 4) << 6)
    s[:, 8:12] = (sc[:, 4:8] & 15) | ((mn[:, 4:8] & 15) << 4)
    q = q.reshape(-1, 4, 2, 32)                             # [n, chunk, half, l]: sub-block 2c is the low nibble
    out = np.empty((v.shape[0], 144), np.uint8)
    out[:, 0:2] = d16.view(np.uint8).reshape(-1, 2)
    out[:, 2:4] = m16.view(np.uint8).reshape(-1, 2)
    out[:, 4:16] = s
    out[:, 16:144] = (q[:, :, 0, :] | (q[:, :, 1, :] << 4)).reshape(-1, 128)
    return out


def q4_k_to_q5_k(raw: np.ndarray) -> np.ndarray:
    """Q4_K blocks (n, 144) -> Q5_K blocks (n, 176) with the same values: the same d, dmin, scales and low nibbles, every
    high bit 0 (Q5_K is Q4_K plus one bit per value, in the same layout)."""
    b = raw.reshape(-1, 144)
    out = np.zeros((b.shape[0], 176), np.uint8)
    out[:, 0:16] = b[:, 0:16]
    out[:, 48:176] = b[:, 16:144]
    return out


def dequant_q8_0(raw: np.ndarray) -> np.ndarray:
    b = raw.reshape(-1, 34)
    return _f16(b[:, 0:2])[:, None] * b[:, 2:34].view(np.int8).astype(np.float32)


DEQUANT = {10: (dequant_q2_k, 84), 11: (dequant_q3_k, 110), 12: (dequant_q4_k, 144), 13: (dequant_q5_k, 176),
           8: (dequant_q8_0, 34)}


def encode(src_type: int, dst_type: int, raw: np.ndarray) -> np.ndarray:
    """Source blocks (whole 256-value super-blocks) -> blocks of dst_type, in order."""
    if src_type == Q4_K and dst_type == Q5_K:
        return q4_k_to_q5_k(raw)                       # exact
    fn, bb = DEQUANT[src_type]
    x = fn(raw.reshape(-1, bb)).reshape(-1)
    if dst_type == Q4_K:
        return quant_q4_k(x)
    if dst_type == Q5_K:
        return q4_k_to_q5_k(quant_q4_k(x))
    if dst_type == Q8_0:
        return quant_q8_0(x)
    raise ValueError(f"no encoder for {GGML_TYPES.get(dst_type)}")


def quant_q8_0(x: np.ndarray) -> np.ndarray:
    """float32 values (a multiple of 32) -> Q8_0 blocks (n, 34) as ggml's quantize_row_q8_0_ref: d = amax / 127,
    q = roundf(x / d), d stored as fp16."""
    v = x.reshape(-1, 32).astype(np.float32)
    amax = np.abs(v).max(1)
    d = amax / 127.0
    with np.errstate(divide="ignore"):
        idv = np.where(d != 0, 1.0 / d, 0.0).astype(np.float32)
    s = v * idv[:, None]
    q = (np.sign(s) * np.floor(np.abs(s) + 0.5)).astype(np.int8)          # roundf: halves away from zero
    out = np.empty((v.shape[0], 34), np.uint8)
    out[:, 0:2] = d.astype("<f2").view(np.uint8).reshape(-1, 2)
    out[:, 2:34] = q.view(np.uint8)
    return out


# --------------------------------------------------------------------------------------------- the file
def _nbytes(type_id: int, shape: list[int]) -> int:
    be, bb = BLOCK_GEOMETRY[GGML_TYPES[type_id]]
    n = 1
    for s in shape:
        n *= s
    if n % be:
        raise ValueError(f"{n} values are not whole {GGML_TYPES[type_id]} blocks")
    return n // be * bb


def _layers(g: GGUFFile) -> tuple[int, int]:
    arch = g.metadata.get("general.architecture")
    if arch != "qwen35moe":
        raise SystemExit(f"{g.path.name}: architecture {arch!r}, this tool is for Qwen3.6-35B-A3B (qwen35moe)")
    blocks = int(g.metadata["qwen35moe.block_count"])
    n_mtp = int(g.metadata.get("qwen35moe.nextn_predict_layers", 0))
    return blocks - n_mtp, n_mtp


def plan(g: GGUFFile, recompact: bool = False, fmt: str = "compact") -> dict:
    """What the engine says about this file: {'main_bad': [...], 'mtp_bad': [...], 'convert': {tensor name: new type}}.
    `recompact`: an MTP block an earlier version of this tool wrote as Q8_0 is converted again (to the compact types)."""
    n_main, n_mtp = _layers(g)
    roles: dict[int, dict[str, int]] = {}
    for t in g.tensors:
        m = EXPERT_RE.match(t.name)
        if m:
            roles.setdefault(int(m.group(1)), {})[m.group(2)] = t.type_id
    main_bad, mtp_bad, convert, unconvertible = [], [], {}, []
    for layer, r in sorted(roles.items()):
        gu_ok = r["gate"] == r["up"] and r["gate"] in ENGINE_GU
        d_ok = r["down"] in ENGINE_D
        mtp = layer >= n_main
        if mtp and recompact and Q8_0 in (r["gate"], r["up"], r["down"]):
            gu_ok, d_ok = gu_ok and r["gate"] != Q8_0, d_ok and r["down"] != Q8_0
        if gu_ok and d_ok:
            continue
        desc = f"blk.{layer}: {GGML_TYPES.get(r['gate'])}/{GGML_TYPES.get(r['up'])}/{GGML_TYPES.get(r['down'])}"
        if layer < n_main:
            main_bad.append(desc)
            continue
        mtp_bad.append(desc)
        # gate and up share a type: both are converted when either is
        for role in (("gate", "up") if not gu_ok else ()) + (("down",) if not d_ok else ()):
            if r[role] not in CONVERTIBLE:
                unconvertible.append(f"blk.{layer}.ffn_{role}_exps ({GGML_TYPES.get(r[role])})")
            convert[f"blk.{layer}.ffn_{role}_exps.weight"] = (TARGET_Q8 if fmt == "q8_0" else TARGET)[role]
    return {"n_main": n_main, "n_mtp": n_mtp, "main_bad": main_bad, "mtp_bad": mtp_bad, "convert": convert,
            "unconvertible": unconvertible}


_SCALAR_BYTES = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}


def _header_end_of_kv(path: pathlib.Path) -> int:
    """The byte offset where the tensor infos begin (after the last metadata entry)."""
    with path.open("rb") as fh:
        (n_kv,) = struct.unpack("<Q", fh.read(24)[16:24])

        def skip_value(t: int) -> None:
            if t == 8:
                (n,) = struct.unpack("<Q", fh.read(8))
                fh.seek(n, 1)
            elif t == 9:
                et, cnt = struct.unpack("<IQ", fh.read(12))
                if et == 8:
                    for _ in range(cnt):
                        (n,) = struct.unpack("<Q", fh.read(8))
                        fh.seek(n, 1)
                else:
                    fh.seek(cnt * _SCALAR_BYTES[et], 1)
            else:
                fh.seek(_SCALAR_BYTES[t], 1)

        for _ in range(n_kv):
            (n,) = struct.unpack("<Q", fh.read(8))
            fh.seek(n, 1)
            (t,) = struct.unpack("<I", fh.read(4))
            skip_value(t)
        return fh.tell()


def _kv_string(key: str, value: str) -> bytes:
    k, v = key.encode(), value.encode()
    return struct.pack("<Q", len(k)) + k + struct.pack("<I", 8) + struct.pack("<Q", len(v)) + v


def convert_tensor(src, offset: int, type_id: int, nbytes: int, out, dst_type: int = Q8_0) -> int:
    """Stream one tensor's blocks through encode() into dst_type, writing to `out`.  Returns the bytes written.  Every
    block kind runs along the rows in order (a 256-value K block is eight Q8_0 blocks), so the layout is kept."""
    _fn, bb = DEQUANT[type_id]
    per = 256 // (32 if type_id == Q8_0 else 256)   # source blocks per 256 values: steps stay whole super-blocks
    n_blocks = nbytes // bb
    written = 0
    src.seek(offset)
    step = max(per, (4 << 20) // bb // per * per)   # ~4 MB of source blocks a step
    done = 0
    while done < n_blocks:
        k = min(step, n_blocks - done)
        raw = np.frombuffer(src.read(k * bb), np.uint8)
        if raw.size != k * bb:
            raise SystemExit("the source file ends inside a tensor")
        q = encode(type_id, dst_type, raw.reshape(k, bb))
        out.write(q.tobytes())
        written += q.size
        done += k
    return written


def run(src_path: pathlib.Path, out_path: pathlib.Path, force: bool = False, recompact: bool = False,
        fmt: str = "compact") -> int:
    g = GGUFFile(src_path)
    p = plan(g, recompact and fmt != "q8_0", fmt)
    if p["main_bad"]:
        print("this file cannot run on the engine: main layers in types it has no kernels for:\n  " +
              "\n  ".join(p["main_bad"]), file=sys.stderr)
        return 2
    if p["unconvertible"]:
        print("the MTP block has types this tool cannot convert: " + ", ".join(p["unconvertible"]), file=sys.stderr)
        return 2
    if not p["convert"]:
        print(f"{src_path.name}: the engine takes this file as it is; nothing to convert")
        return 0
    if out_path.exists() and not force:
        print(f"{out_path} exists (--force to overwrite)", file=sys.stderr)
        return 2
    if out_path.resolve() == src_path.resolve():
        print("the output must be another file", file=sys.stderr)
        return 2

    kv_end = _header_end_of_kv(src_path)
    changed = sorted(p["convert"])
    note = "; ".join(f"{n}: {GGML_TYPES[next(t.type_id for t in g.tensors if t.name == n)]} -> {GGML_TYPES[p['convert'][n]]}"
                     for n in changed)
    extra_kv = _kv_string("strata.q36.mtp_requant", note)
    align = g.alignment

    # the new tensor infos: same order, new types / offsets
    infos, layout, off = [], [], 0
    for t in g.tensors:
        new_type = p["convert"].get(t.name, t.type_id)
        nb_src = _nbytes(t.type_id, t.shape)
        nb_dst = _nbytes(new_type, t.shape)
        off = (off + align - 1) // align * align
        name = t.name.encode()
        infos.append(struct.pack("<Q", len(name)) + name + struct.pack("<I", len(t.shape)) +
                     struct.pack(f"<{len(t.shape)}Q", *t.shape) + struct.pack("<IQ", new_type, off))
        layout.append((t, new_type, nb_src, nb_dst, off))
        off += nb_dst

    tmp = out_path.with_name(out_path.name + ".part")
    t0 = time.time()
    with src_path.open("rb") as src, tmp.open("wb") as out:
        head = bytearray(src.read(kv_end))
        n_kv = struct.unpack("<Q", head[16:24])[0]
        head[16:24] = struct.pack("<Q", n_kv + 1)
        out.write(head)
        out.write(extra_kv)
        for b in infos:
            out.write(b)
        pos = out.tell()
        data_start = (pos + align - 1) // align * align
        out.write(b"\0" * (data_start - pos))
        for t, new_type, nb_src, nb_dst, rel in layout:
            cur = out.tell() - data_start
            if cur < rel:
                out.write(b"\0" * (rel - cur))
            if new_type == t.type_id:
                src.seek(g.data_start + t.offset)
                left = nb_src
                while left:
                    buf = src.read(min(CHUNK, left))
                    if not buf:
                        raise SystemExit(f"the source file ends inside {t.name}")
                    out.write(buf)
                    left -= len(buf)
            else:
                w = convert_tensor(src, g.data_start + t.offset, t.type_id, nb_src, out, new_type)
                if w != nb_dst:
                    raise SystemExit(f"{t.name}: wrote {w} bytes, expected {nb_dst}")
                print(f"  {t.name}: {GGML_TYPES[t.type_id]} -> {GGML_TYPES[new_type]} ({nb_src / 2**20:.0f} -> {nb_dst / 2**20:.0f} MiB)")
    os.replace(tmp, out_path)

    # read the result back: the same tensors, the converted ones Q8_0, and the engine takes every layer
    g2 = GGUFFile(out_path)
    if [t.name for t in g2.tensors] != [t.name for t in g.tensors]:
        raise SystemExit("check failed: the tensor list differs")
    last = g2.tensors[-1]
    if g2.data_start + last.offset + _nbytes(last.type_id, last.shape) != out_path.stat().st_size:
        raise SystemExit("check failed: the file size does not match its tensors")
    p2 = plan(g2)
    if p2["main_bad"] or p2["mtp_bad"]:
        raise SystemExit(f"check failed: still unsupported: {p2['main_bad'] + p2['mtp_bad']}")
    print(f"{out_path.name}: {out_path.stat().st_size / 1e9:.2f} GB written in {time.time() - t0:.0f} s; "
          f"the engine takes every layer")
    return 0


def check(path: pathlib.Path) -> int:
    g = GGUFFile(path)
    p = plan(g)
    print(f"{path.name}: {p['n_main']} main layers, {p['n_mtp']} MTP block(s)")
    if p["n_mtp"] == 0:
        print("  no MTP block: this engine needs a file with one (unsloth/Qwen3.6-35B-A3B-MTP-GGUF)")
        return 2
    if p["main_bad"]:
        kinds: dict[str, int] = {}
        for desc in p["main_bad"]:
            kinds[desc.split(": ", 1)[1]] = kinds.get(desc.split(": ", 1)[1], 0) + 1
        print(f"  cannot run: {len(p['main_bad'])} main layers have expert types the engine has no GPU kernels for "
              "(gate/up/down): " + ", ".join(f"{k} x{n}" for k, n in kinds.items()))
        return 2
    if p["mtp_bad"]:
        print("  needs conversion (this tool): the MTP block's experts are " + ", ".join(p["mtp_bad"]))
        return 1
    print("  the engine takes it as it is")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("src", type=pathlib.Path)
    ap.add_argument("out", type=pathlib.Path, nargs="?")
    ap.add_argument("--check", action="store_true", help="only say whether the engine takes the file")
    ap.add_argument("--force", action="store_true", help="overwrite OUT")
    ap.add_argument("--mtp-format", choices=["compact", "q8_0"], default="compact",
                    help="compact (default): gate / up Q4_K, down Q5_K (475 MiB, small enough for the prompt staging "
                         "beside a 128K 8-bit cache on 8 GB); q8_0: the first form (816 MiB), the file setup pins")
    ap.add_argument("--recompact", action="store_true",
                    help="convert an MTP block an earlier version of this tool wrote as Q8_0 again, to Q4_K / Q5_K")
    a = ap.parse_args(argv)
    if a.check or a.out is None:
        return check(a.src)
    return run(a.src, a.out, a.force, a.recompact, a.mtp_format)


if __name__ == "__main__":
    sys.exit(main())
