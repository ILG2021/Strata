"""tools/q36_fast_requant.py - give a Qwen3.6-35B-A3B GGUF the expert formats the engine's fast prompt kernels take.

The engine (src/qwen35/q36_engine.cu) reads a prompt chunk's routed experts on its fast kernels (fused, int8) only when
EVERY layer has such a route (strata/kernels/q36_prompt_route.hpp: q36_prompt_path_ok); one layer without one sends every
layer to the slower grouped kernels, and the streamed (staged) prompt path of the hybrid mode is off too.  A release
engine links no ggml, so llama.cpp's MMQ is not there to take the other formats.

Unsloth's low-bit Qwen3.6 files store most routed `down` projections as IQ4_XS (UD-IQ3_S: 37 of 40 layers), which the
int8 expert kernels do not take as a down (engine/src/kernels/cuda/i8_expert.cuh, i8_d_type) and the fused ones neither
(moe_fused_iq.cu, d_covered).  This tool rewrites only such down tensors, and only where the change keeps the values:

  IQ4_XS -> IQ4_NL   the same 16-value 4-bit codebook (kvalues_iq4nl) and the same nibble layout per 32 values; IQ4_XS
                     stores one fp16 scale per 256 values times a 6-bit sub-scale per 32, IQ4_NL one fp16 scale per 32.
                     Every 4-bit code is copied as it is; the 32-value block's scale d * (ls - 32) is rounded to fp16
                     (relative error <= 2^-11).  4.25 -> 4.5 bits a value.
  Q4_K   -> Q5_K     exact (Q5_K is Q4_K with one more bit, left 0; q36_mtp_requant.q4_k_to_q5_k).

Nothing else changes: every other tensor is copied byte for byte, the metadata is kept (one entry, strata.q36.fast_requant,
says what was converted; a key the file has twice - q36_mtp_requant's two passes each add strata.q36.mtp_requant - is
kept once, its last value), and the conversion is deterministic, so every PC makes the same file from the same input.

    python tools/q36_fast_requant.py --check FILE.gguf        0: nothing to do, 1: would convert, 2: not a Qwen3.6 file
    python tools/q36_fast_requant.py FILE.gguf OUT.gguf [--json]
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import struct
import sys
import time

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from gguf_reader import GGML_TYPES, GGUFFile  # noqa: E402
from q36_mtp_requant import _nbytes, q4_k_to_q5_k  # noqa: E402

Q4_K, Q5_K, Q6_K, IQ4_NL, IQ4_XS = 12, 13, 14, 20, 23
# the int8 expert kernels' formats (engine/src/kernels/cuda/i8_expert.cuh: i8_gu_type / i8_d_type) - the route every card has
I8_GU = {16, 17, 18, 21, 22, 23, 29, 42, 12, 13, 14, 8}
I8_D = {20, 42, 6, 8, 7, 13, 14}
# what a down that has no route becomes (only value-keeping conversions)
DOWN_TO = {IQ4_XS: IQ4_NL, Q4_K: Q5_K}
KEY = "strata.q36.fast_requant"
EXPERT_RE = re.compile(r"^blk\.(\d+)\.ffn_(gate|up|down)_exps\.weight$")
CHUNK = 64 << 20
KVALUES = np.array([-127, -104, -83, -65, -49, -35, -22, -10, 1, 13, 25, 38, 53, 69, 89, 113], np.float32)


# --------------------------------------------------------------------------------------------- the formats
def _f16(raw: np.ndarray) -> np.ndarray:
    return np.ascontiguousarray(raw).view("<f2").reshape(-1).astype(np.float32)


def iq4_xs_scales(b: np.ndarray) -> np.ndarray:
    """IQ4_XS blocks (n, 136): d, scales_h, scales_l[4], qs[128] -> the 8 per-32 scales d * (ls - 32) as float32 (n, 8)
    (ggml-quants.c dequantize_row_iq4_xs)."""
    d = _f16(b[:, 0:2])[:, None]
    sh = np.ascontiguousarray(b[:, 2:4]).view("<u2").reshape(-1, 1).astype(np.int32)
    sl = b[:, 4:8].astype(np.int32)
    ib = np.arange(8)
    lo = (sl[:, ib // 2] >> (4 * (ib % 2))) & 0xF
    hi = (sh >> (2 * ib)) & 3
    return d * ((lo | (hi << 4)) - 32).astype(np.float32)


def iq4_xs_to_iq4_nl(raw: np.ndarray) -> np.ndarray:
    """IQ4_XS blocks (n, 136) -> IQ4_NL blocks (8n, 18): block 8i + j is sub-block j of block i, its fp16 scale
    d * (ls_j - 32) and its 16 code bytes copied."""
    b = raw.reshape(-1, 136)
    out = np.empty((b.shape[0], 8, 18), np.uint8)
    out[:, :, 0:2] = iq4_xs_scales(b).astype("<f2").view(np.uint8).reshape(-1, 8, 2)
    out[:, :, 2:18] = b[:, 8:136].reshape(-1, 8, 16)
    return out.reshape(-1, 18)


def dequant_iq4_xs(raw: np.ndarray) -> np.ndarray:
    b = raw.reshape(-1, 136)
    q = b[:, 8:136].reshape(-1, 8, 16)
    v = np.concatenate([KVALUES[q & 0xF], KVALUES[q >> 4]], 2)          # [n, 8, 32]: low nibbles first, as ggml
    return (iq4_xs_scales(b)[:, :, None] * v).reshape(-1)


def dequant_iq4_nl(raw: np.ndarray) -> np.ndarray:
    b = raw.reshape(-1, 18)
    q = b[:, 2:18]
    v = np.concatenate([KVALUES[q & 0xF], KVALUES[q >> 4]], 1)          # [n, 32]
    return (_f16(b[:, 0:2])[:, None] * v).reshape(-1)


ENCODE = {(IQ4_XS, IQ4_NL): (iq4_xs_to_iq4_nl, 136), (Q4_K, Q5_K): (q4_k_to_q5_k, 144)}


# --------------------------------------------------------------------------------------------- the plan
def _qwen36(g: GGUFFile) -> int:
    arch = g.metadata.get("general.architecture")
    if arch != "qwen35moe":
        raise ValueError(f"{g.path.name}: architecture {arch!r}, not Qwen3.6-35B-A3B (qwen35moe)")
    return int(g.metadata["qwen35moe.block_count"])


def _route_ok(gu: int, d: int, n_ff: int) -> bool:
    """The int8 expert kernels take this pair (native_expert_i8_supported's type tests; Q5_K / Q6_K downs need whole 256-value
    super-blocks along n_ff)."""
    return gu in I8_GU and d in I8_D and (d not in (Q5_K, Q6_K) or n_ff % 256 == 0)


def plan(g: GGUFFile) -> dict:
    """{'convert': {tensor name: new type}, 'slow': [layers still without a fast route after the conversion], 'layers': n}."""
    _qwen36(g)
    roles: dict[int, dict[str, object]] = {}
    for t in g.tensors:
        m = EXPERT_RE.match(t.name)
        if m:
            roles.setdefault(int(m.group(1)), {})[m.group(2)] = t
    convert, slow = {}, []
    for layer, r in sorted(roles.items()):
        gate, up, down = r.get("gate"), r.get("up"), r.get("down")
        if gate is None or up is None or down is None:
            continue
        n_ff = int(down.shape[0])                       # down [n_ff, n_embd, n_expert]
        gu = gate.type_id if gate.type_id == up.type_id else -1
        if _route_ok(gu, down.type_id, n_ff):
            continue
        new_d = DOWN_TO.get(down.type_id)
        if new_d is not None and _route_ok(gu, new_d, n_ff):
            convert[down.name] = new_d
        else:
            slow.append(layer)
    return {"convert": convert, "slow": slow, "layers": len(roles)}


# --------------------------------------------------------------------------------------------- the file
_SCALAR = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}


def _kv_spans(path: pathlib.Path) -> tuple[bytes, list[tuple[str, bytes]], int]:
    """(the 24-byte file head, [(key, the entry's bytes)], the offset where the tensor infos begin)."""
    with path.open("rb") as fh:
        head = fh.read(24)
        (n_kv,) = struct.unpack("<Q", head[16:24])

        def skip(t: int) -> None:
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
                    fh.seek(cnt * _SCALAR[et], 1)
            else:
                fh.seek(_SCALAR[t], 1)

        spans = []
        for _ in range(n_kv):
            start = fh.tell()
            (n,) = struct.unpack("<Q", fh.read(8))
            key = fh.read(n).decode("utf-8", "replace")
            (t,) = struct.unpack("<I", fh.read(4))
            skip(t)
            end = fh.tell()
            fh.seek(start)
            spans.append((key, fh.read(end - start)))
        return head, spans, fh.tell()


def _kv_string(key: str, value: str) -> bytes:
    k, v = key.encode(), value.encode()
    return struct.pack("<Q", len(k)) + k + struct.pack("<I", 8) + struct.pack("<Q", len(v)) + v


def _convert_tensor(src, offset: int, src_type: int, dst_type: int, nbytes: int, out) -> int:
    fn, bb = ENCODE[(src_type, dst_type)]
    n_blocks, done, written = nbytes // bb, 0, 0
    step = max(1, (4 << 20) // bb)
    src.seek(offset)
    while done < n_blocks:
        k = min(step, n_blocks - done)
        raw = np.frombuffer(src.read(k * bb), np.uint8)
        if raw.size != k * bb:
            raise ValueError("the source file ends inside a tensor")
        q = fn(raw.reshape(k, bb))
        out.write(q.tobytes())
        written += q.size
        done += k
    return written


def run(src_path: pathlib.Path, out_path: pathlib.Path, progress=None) -> dict:
    """Write the converted file.  Returns {'converted': n, 'slow': [...], 'bytes': size, 'seconds': s}; nothing is written
    when there is nothing to convert ('converted': 0).  `progress(done_bytes, total_bytes)` is called as the copy goes."""
    if out_path.resolve() == src_path.resolve():
        raise ValueError("the output must be another file")
    g = GGUFFile(src_path)
    p = plan(g)
    if not p["convert"]:
        return {"converted": 0, "slow": p["slow"], "bytes": 0, "seconds": 0.0}
    head, spans, _kv_end = _kv_spans(src_path)
    # the metadata: each key once (its last value), this tool's entry replaced
    last: dict[str, bytes] = {}
    order: list[str] = []
    for key, raw in spans:
        if key not in last:
            order.append(key)
        last[key] = raw
    note = "; ".join(f"{n}: {GGML_TYPES[next(t.type_id for t in g.tensors if t.name == n)]} -> {GGML_TYPES[p['convert'][n]]}"
                     for n in sorted(p["convert"]))
    last[KEY] = _kv_string(KEY, note)
    if KEY not in order:
        order.append(KEY)
    kv = b"".join(last[k] for k in order)
    align = g.alignment

    infos, layout, off = [], [], 0
    for t in g.tensors:
        new_type = p["convert"].get(t.name, t.type_id)
        nb_src, nb_dst = _nbytes(t.type_id, t.shape), _nbytes(new_type, t.shape)
        off = (off + align - 1) // align * align
        name = t.name.encode()
        infos.append(struct.pack("<Q", len(name)) + name + struct.pack("<I", len(t.shape)) +
                     struct.pack(f"<{len(t.shape)}Q", *t.shape) + struct.pack("<IQ", new_type, off))
        layout.append((t, new_type, nb_src, nb_dst, off))
        off += nb_dst
    total = sum(nb for _t, _n, nb, _d, _o in layout)

    tmp = out_path.with_name(out_path.name + ".part")
    t0, done = time.time(), 0
    with src_path.open("rb") as src, tmp.open("wb") as out:
        out.write(head[:16] + struct.pack("<Q", len(order)))
        out.write(kv)
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
                        raise ValueError(f"the source file ends inside {t.name}")
                    out.write(buf)
                    left -= len(buf)
            elif _convert_tensor(src, g.data_start + t.offset, t.type_id, new_type, nb_src, out) != nb_dst:
                raise ValueError(f"{t.name}: the converted size is not {nb_dst} bytes")
            done += nb_src
            if progress:
                progress(done, total)
    verify(src_path, tmp, p["convert"])
    os.replace(tmp, out_path)
    return {"converted": len(p["convert"]), "slow": p["slow"], "bytes": out_path.stat().st_size,
            "seconds": round(time.time() - t0, 1)}


def verify(src_path: pathlib.Path, out_path: pathlib.Path, convert: dict, samples: int = 64) -> None:
    """The written file: the same tensors in the same order and shapes, its size the end of its last tensor, every unchanged
    tensor's bytes equal, and every converted tensor's values those of the source (fp16 scale rounding only), on `samples`
    spots per tensor."""
    a, b = GGUFFile(src_path), GGUFFile(out_path)
    if [(t.name, t.shape) for t in a.tensors] != [(t.name, t.shape) for t in b.tensors]:
        raise ValueError("check failed: the tensor list differs")
    last = b.tensors[-1]
    if b.data_start + last.offset + _nbytes(last.type_id, last.shape) != out_path.stat().st_size:
        raise ValueError("check failed: the file size does not match its tensors")
    rng = np.random.default_rng(0)
    with src_path.open("rb") as fa, out_path.open("rb") as fb:
        for ta, tb in zip(a.tensors, b.tensors):
            na, nb = _nbytes(ta.type_id, ta.shape), _nbytes(tb.type_id, tb.shape)
            if ta.name not in convert:
                if tb.type_id != ta.type_id or na != nb:
                    raise ValueError(f"check failed: {ta.name} changed")
                for pos in rng.integers(0, max(1, na - 4096), size=4):     # spot bytes
                    fa.seek(a.data_start + ta.offset + int(pos)); fb.seek(b.data_start + tb.offset + int(pos))
                    if fa.read(4096) != fb.read(4096):
                        raise ValueError(f"check failed: {ta.name} bytes differ")
                continue
            if tb.type_id != convert[ta.name]:
                raise ValueError(f"check failed: {ta.name} is {GGML_TYPES[tb.type_id]}")
            if (ta.type_id, tb.type_id) == (IQ4_XS, IQ4_NL):
                n_super = na // 136
                for i in rng.integers(0, n_super, size=samples):
                    fa.seek(a.data_start + ta.offset + int(i) * 136)
                    fb.seek(b.data_start + tb.offset + int(i) * 8 * 18)
                    x = dequant_iq4_xs(np.frombuffer(fa.read(136), np.uint8))
                    y = dequant_iq4_nl(np.frombuffer(fb.read(8 * 18), np.uint8))
                    tol = np.abs(x).max() * 2.0 ** -10 + 1e-30
                    if not np.all(np.abs(x - y) <= tol):
                        raise ValueError(f"check failed: {ta.name} block {int(i)} values differ by {np.abs(x - y).max()}")
            # (Q4_K -> Q5_K is a byte copy into the new layout: q36_mtp_requant's tests hold it exact)


def check(path: pathlib.Path) -> tuple[int, dict]:
    """0: nothing to convert, 1: would convert, 2: not a Qwen3.6 file (or unreadable)."""
    try:
        p = plan(GGUFFile(path))
    except (ValueError, KeyError, OSError, struct.error) as e:
        return 2, {"error": str(e)}
    return (1 if p["convert"] else 0), {"convert": len(p["convert"]), "slow": p["slow"], "layers": p["layers"]}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("src", type=pathlib.Path)
    ap.add_argument("out", type=pathlib.Path, nargs="?")
    ap.add_argument("--check", action="store_true", help="only say whether the file would be converted")
    ap.add_argument("--json", action="store_true", help="one JSON line of the result (and progress lines) on stdout")
    a = ap.parse_args(argv)
    if a.check or a.out is None:
        code, info = check(a.src)
        print(json.dumps({"code": code, **info}) if a.json else
              {0: "nothing to convert", 1: f"would convert {info.get('convert')} down tensors", 2: info.get("error")}[code])
        return code
    last = [0.0]

    def progress(done: int, total: int) -> None:
        now = time.time()
        if a.json and (now - last[0] > 1.0 or done == total):
            last[0] = now
            print(json.dumps({"progress": round(done / total, 4)}), flush=True)

    try:
        r = run(a.src, a.out, progress)
    except (ValueError, OSError) as e:
        print(json.dumps({"error": str(e)}) if a.json else f"error: {e}", file=sys.stdout if a.json else sys.stderr)
        return 2
    print(json.dumps({"done": True, **r}) if a.json else
          f"{a.out.name}: {r['converted']} tensors converted, {r['bytes'] / 1e9:.2f} GB in {r['seconds']} s"
          + (f"; layers still without a fast route: {r['slow']}" if r["slow"] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
