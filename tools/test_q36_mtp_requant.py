"""tools/q36_mtp_requant.py: the dequantizers against ggml's scalar loops (transcribed from ggml-quants.c), the
Q8_0 quantizer's rounding, and a whole conversion of a small synthetic qwen35moe GGUF.  No GPU, no download.

    python -m unittest tools.test_q36_mtp_requant
"""
from __future__ import annotations

import pathlib
import struct
import sys
import tempfile
import unittest

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import q36_mtp_requant as R  # noqa: E402
from gguf_reader import GGUFFile  # noqa: E402


def f16(b: bytes) -> float:
    return float(np.frombuffer(b, "<f2")[0])


# ----------------------------------------------------------------- ggml-quants.c, one block at a time, as written there
def ref_q2_k(blk: bytes) -> list[float]:
    scales, qs, d, dmin = blk[0:16], blk[16:80], f16(blk[80:82]), f16(blk[82:84])
    y, q, is_ = [], 0, 0
    for _n in range(0, 256, 128):
        shift = 0
        for _j in range(4):
            sc = scales[is_]; is_ += 1
            dl, ml = d * (sc & 0xF), dmin * (sc >> 4)
            y += [dl * ((qs[q + l] >> shift) & 3) - ml for l in range(16)]
            sc = scales[is_]; is_ += 1
            dl, ml = d * (sc & 0xF), dmin * (sc >> 4)
            y += [dl * ((qs[q + l + 16] >> shift) & 3) - ml for l in range(16)]
            shift += 2
        q += 32
    return y


def ref_q4_k(blk: bytes) -> list[float]:
    d, dmin, sc, qs = f16(blk[0:2]), f16(blk[2:4]), blk[4:16], blk[16:144]

    def get(j):
        if j < 4:
            return sc[j] & 63, sc[j + 4] & 63
        return (sc[j + 4] & 0xF) | ((sc[j - 4] >> 6) << 4), (sc[j + 4] >> 4) | ((sc[j] >> 6) << 4)

    y, q, is_ = [], 0, 0
    for _j in range(0, 256, 64):
        s, m = get(is_); d1, m1 = d * s, dmin * m
        s, m = get(is_ + 1); d2, m2 = d * s, dmin * m
        y += [d1 * (qs[q + l] & 0xF) - m1 for l in range(32)]
        y += [d2 * (qs[q + l] >> 4) - m2 for l in range(32)]
        q += 32; is_ += 2
    return y


def ref_q3_k(blk: bytes) -> list[float]:
    hm, qs, sraw, d = blk[0:32], blk[32:96], blk[96:108], f16(blk[108:110])
    aux = list(struct.unpack("<3I", sraw)) + [0]
    k1, k2 = 0x03030303, 0x0F0F0F0F
    tmp = aux[2]
    aux[2] = ((aux[0] >> 4) & k2) | (((tmp >> 4) & k1) << 4)
    aux[3] = ((aux[1] >> 4) & k2) | (((tmp >> 6) & k1) << 4)
    aux[0] = (aux[0] & k2) | (((tmp >> 0) & k1) << 4)
    aux[1] = (aux[1] & k2) | (((tmp >> 2) & k1) << 4)
    scales = struct.unpack("<16b", struct.pack("<4I", *aux))
    y, q, is_, m = [], 0, 0, 1
    for _n in range(0, 256, 128):
        shift = 0
        for _j in range(4):
            dl = d * (scales[is_] - 32); is_ += 1
            y += [dl * (((qs[q + l] >> shift) & 3) - (0 if hm[l] & m else 4)) for l in range(16)]
            dl = d * (scales[is_] - 32); is_ += 1
            y += [dl * (((qs[q + l + 16] >> shift) & 3) - (0 if hm[l + 16] & m else 4)) for l in range(16)]
            shift += 2; m <<= 1
        q += 32
    return y


def ref_q5_k(blk: bytes) -> list[float]:
    d, dmin, sc, qh, ql = f16(blk[0:2]), f16(blk[2:4]), blk[4:16], blk[16:48], blk[48:176]

    def get(j):
        if j < 4:
            return sc[j] & 63, sc[j + 4] & 63
        return (sc[j + 4] & 0xF) | ((sc[j - 4] >> 6) << 4), (sc[j + 4] >> 4) | ((sc[j] >> 6) << 4)

    y, q, is_, u1, u2 = [], 0, 0, 1, 2
    for _j in range(0, 256, 64):
        s, m = get(is_); d1, m1 = d * s, dmin * m
        s, m = get(is_ + 1); d2, m2 = d * s, dmin * m
        y += [d1 * ((ql[q + l] & 0xF) + (16 if qh[l] & u1 else 0)) - m1 for l in range(32)]
        y += [d2 * ((ql[q + l] >> 4) + (16 if qh[l] & u2 else 0)) - m2 for l in range(32)]
        q += 32; is_ += 2; u1 <<= 2; u2 <<= 2
    return y


def random_blocks(rng, n: int, size: int, f16_at: list[int]) -> np.ndarray:
    b = rng.integers(0, 256, (n, size), dtype=np.uint8)
    for at in f16_at:   # finite, modest scales (random bytes would give inf / nan halves)
        b[:, at:at + 2] = rng.uniform(-0.05, 0.05, n).astype("<f2").view(np.uint8).reshape(n, 2)
    return b


class Dequant(unittest.TestCase):
    def check(self, fn, ref, size, f16_at):
        rng = np.random.default_rng(1)
        blocks = random_blocks(rng, 64, size, f16_at)
        got = fn(blocks)
        want = np.array([ref(bytes(b)) for b in blocks], np.float32)
        np.testing.assert_allclose(got, want, rtol=1e-6, atol=1e-7)

    def test_q2_k(self):
        self.check(R.dequant_q2_k, ref_q2_k, 84, [80, 82])

    def test_q3_k(self):
        self.check(R.dequant_q3_k, ref_q3_k, 110, [108])

    def test_q4_k(self):
        self.check(R.dequant_q4_k, ref_q4_k, 144, [0, 2])

    def test_q5_k(self):
        self.check(R.dequant_q5_k, ref_q5_k, 176, [0, 2])


def stored_steps(q4: np.ndarray) -> np.ndarray:
    """A Q4_K block's step of each 32 values as stored: d * scale."""
    d = R._f16(q4[:, 0:2])
    sc, _ = R._k4_scales(q4[:, 4:16])
    return (d[:, None] * sc).reshape(-1)


class QuantK(unittest.TestCase):
    def test_q4_k_to_q5_k_is_exact(self):
        blocks = random_blocks(np.random.default_rng(4), 64, 144, [0, 2])
        np.testing.assert_array_equal(R.dequant_q5_k(R.q4_k_to_q5_k(blocks)), R.dequant_q4_k(blocks))

    def test_q4_k_round_trip_within_a_step(self):
        rng = np.random.default_rng(5)
        for x in (rng.normal(0, 0.02, 256 * 40), rng.uniform(0.01, 0.05, 256 * 8),          # all positive: offset 0
                  R.dequant_q2_k(random_blocks(rng, 40, 84, [80, 82])).reshape(-1)):        # what the tool converts
            x = x.astype(np.float32)
            q = R.quant_q4_k(x)
            back = R.dequant_q4_k(q).reshape(-1, 32)
            v = x.reshape(-1, 32)
            # nothing clips: every value within half of the step actually stored (d * 6-bit scale)
            self.assertTrue(np.all(np.abs(back - v) <= stored_steps(q)[:, None] * 0.5 * (1 + 1e-5) + 1e-8))
            ideal = (v.max(1) - np.minimum(v.min(1), 0)) / 15.0          # and the steps are close to the ideal ones
            self.assertLess(float(np.sqrt(((back - v) ** 2).mean())), float(ideal.mean()) * 0.35)

    def test_q4_k_zero_block(self):
        self.assertTrue(np.all(R.dequant_q4_k(R.quant_q4_k(np.zeros(256, np.float32))) == 0))


class QuantQ8(unittest.TestCase):
    def test_round_trip_within_half_a_step(self):
        x = np.random.default_rng(2).normal(0, 0.02, 32 * 50).astype(np.float32)
        q = R.quant_q8_0(x)
        back = R.dequant_q8_0(q).reshape(-1)
        d = R._f16(q[:, 0:2])
        step = np.repeat(d, 32)
        self.assertTrue(np.all(np.abs(back - x) <= step * 0.5 + np.abs(x) * 2e-3 + 1e-9))

    def test_zero_block_and_rounding(self):
        self.assertTrue(np.all(R.quant_q8_0(np.zeros(32, np.float32)) == 0))
        x = np.zeros(32, np.float32)
        x[0], x[1], x[2] = 127.0, 2.5, -2.5          # d = 1: halves go away from zero (roundf), not to even
        q = R.quant_q8_0(x)[0, 2:].view(np.int8)
        self.assertEqual((q[0], q[1], q[2]), (127, 3, -3))


# ----------------------------------------------------------------- a whole file
def _s(x: str) -> bytes:
    b = x.encode()
    return struct.pack("<Q", len(b)) + b


def write_gguf(path: pathlib.Path, kv: list[tuple[str, int, bytes]], tensors: list[tuple[str, list[int], int, bytes]],
               align: int = 32) -> None:
    head = struct.pack("<IIQQ", 0x46554747, 3, len(tensors), len(kv))
    for k, t, v in kv:
        head += _s(k) + struct.pack("<I", t) + v
    off, infos, datas = 0, b"", []
    for name, shape, typ, data in tensors:
        off = (off + align - 1) // align * align
        infos += _s(name) + struct.pack("<I", len(shape)) + struct.pack(f"<{len(shape)}Q", *shape) + struct.pack("<IQ", typ, off)
        datas.append((off, data))
        off += len(data)
    blob = head + infos
    blob += b"\0" * ((-len(blob)) % align)
    base = len(blob)
    out = bytearray(blob)
    for o, data in datas:
        out += b"\0" * (base + o - len(out))
        out += data
    path.write_bytes(bytes(out))


class WholeFile(unittest.TestCase):
    def make(self, d: pathlib.Path, mtp_types=(10, 10, 12)) -> pathlib.Path:
        rng = np.random.default_rng(3)
        E, FF, EMB = 2, 256, 512        # tiny: 2 experts, gate/up [512, 256, 2], down [256, 512, 2]
        geom = {10: 84, 11: 110, 12: 144, 22: 82, 23: 136, 8: 34}
        f16_at = {10: [80, 82], 11: [108], 12: [0, 2], 22: [0], 23: [0], 8: [0]}

        def blocks(typ, n_vals):
            be = 32 if typ == 8 else 256
            return random_blocks(rng, n_vals // be, geom[typ], f16_at[typ]).tobytes()

        kv = [("general.architecture", 8, _s("qwen35moe")),
              ("qwen35moe.block_count", 4, struct.pack("<I", 2)),
              ("qwen35moe.nextn_predict_layers", 4, struct.pack("<I", 1)),
              ("tokenizer.ggml.tokens", 9, struct.pack("<IQ", 8, 2) + _s("a") + _s("b"))]
        t = [("token_embd.weight", [EMB, 4], 0, rng.normal(size=EMB * 4).astype("<f4").tobytes())]
        for layer, (g, u, dn) in ((0, (22, 22, 23)), (1, mtp_types)):
            t.append((f"blk.{layer}.ffn_gate_exps.weight", [EMB, FF, E], g, blocks(g, EMB * FF * E)))
            t.append((f"blk.{layer}.ffn_up_exps.weight", [EMB, FF, E], u, blocks(u, EMB * FF * E)))
            t.append((f"blk.{layer}.ffn_down_exps.weight", [FF, EMB, E], dn, blocks(dn, EMB * FF * E)))
        t.append(("output_norm.weight", [EMB], 0, np.ones(EMB, "<f4").tobytes()))
        p = d / "in.gguf"
        write_gguf(p, kv, t)
        return p

    def test_converts_only_the_mtp_experts(self):
        with tempfile.TemporaryDirectory() as td:
            d = pathlib.Path(td)
            src = self.make(d)
            self.assertEqual(R.check(src), 1)
            out = d / "out.gguf"
            self.assertEqual(R.run(src, out), 0)
            self.assertEqual(R.check(out), 0)
            a, b = GGUFFile(src), GGUFFile(out)
            self.assertEqual(b.metadata["tokenizer.ggml.tokens"], ["a", "b"])
            self.assertIn("blk.1.ffn_gate_exps.weight: Q2_K -> Q4_K", b.metadata["strata.q36.mtp_requant"])
            self.assertIn("blk.1.ffn_down_exps.weight: Q4_K -> Q5_K", b.metadata["strata.q36.mtp_requant"])
            raw_a, raw_b = src.read_bytes(), out.read_bytes()
            for ta, tb in zip(a.tensors, b.tensors):
                self.assertEqual((ta.name, ta.shape), (tb.name, tb.shape))
                na, nb = R._nbytes(ta.type_id, ta.shape), R._nbytes(tb.type_id, tb.shape)
                da = raw_a[a.data_start + ta.offset:][:na]
                db = raw_b[b.data_start + tb.offset:][:nb]
                if ta.name.startswith("blk.1.ffn_"):
                    down = "down" in ta.name
                    self.assertEqual(tb.type_id, 13 if down else 12)
                    fn, bb = R.DEQUANT[ta.type_id]
                    want = fn(np.frombuffer(da, np.uint8).reshape(-1, bb)).reshape(-1, 32)
                    gfn, gbb = R.DEQUANT[tb.type_id]
                    got = gfn(np.frombuffer(db, np.uint8).reshape(-1, gbb)).reshape(-1, 32)
                    if down:                                   # Q4_K -> Q5_K: the same values
                        np.testing.assert_array_equal(got, want)
                    else:                                      # Q2_K -> Q4_K: within half a stored step of each 32 values
                        q = np.frombuffer(db, np.uint8).reshape(-1, 144)
                        self.assertTrue(np.all(np.abs(got - want) <= stored_steps(q)[:, None] * 0.5 * (1 + 1e-5) + 1e-8))
                else:
                    self.assertEqual(ta.type_id, tb.type_id)
                    self.assertEqual(da, db, ta.name)

    def test_q3_k_mtp_and_nothing_to_do(self):
        with tempfile.TemporaryDirectory() as td:
            d = pathlib.Path(td)
            src = self.make(d, (10, 10, 11))
            self.assertEqual(R.run(src, d / "out.gguf"), 0)
            self.assertEqual(R.check(d / "out.gguf"), 0)
            ok = d / "ok"
            ok.mkdir()
            fine = self.make(ok, (8, 8, 8))                # an MTP block an earlier version wrote as Q8_0
            self.assertEqual(R.check(fine), 0)
            self.assertEqual(R.run(fine, ok / "x.gguf"), 0)
            self.assertFalse((ok / "x.gguf").exists())
            self.assertEqual(R.run(fine, ok / "x.gguf", recompact=True), 0)   # made compact on request
            types = {t.name: t.type_id for t in GGUFFile(ok / "x.gguf").tensors}
            self.assertEqual([types[f"blk.1.ffn_{r}_exps.weight"] for r in ("gate", "up", "down")], [12, 12, 13])
            self.assertEqual(types["blk.0.ffn_down_exps.weight"], 23)

    def test_q8_0_format_is_the_pinned_first_form(self):
        with tempfile.TemporaryDirectory() as td:
            d = pathlib.Path(td)
            src = self.make(d)
            self.assertEqual(R.run(src, d / "q8.gguf", fmt="q8_0"), 0)
            types = {t.name: t.type_id for t in GGUFFile(d / "q8.gguf").tensors}
            self.assertEqual([types[f"blk.1.ffn_{r}_exps.weight"] for r in ("gate", "up", "down")], [8, 8, 8])

    def test_refuses_unsupported_main_layers(self):
        with tempfile.TemporaryDirectory() as td:
            d = pathlib.Path(td)
            src = self.make(d)
            g = GGUFFile(src)
            # blk.0's down as IQ3_S (21): no GPU down kernel; the tool must not touch main layers
            p = R.plan(g)
            self.assertFalse(p["main_bad"])
            raw = bytearray(src.read_bytes())
            name = b"blk.0.ffn_down_exps.weight"
            i = raw.index(name) + len(name) + 4 + 3 * 8
            raw[i:i + 4] = struct.pack("<I", 21)
            bad = d / "bad.gguf"
            bad.write_bytes(bytes(raw))
            self.assertEqual(R.check(bad), 2)
            self.assertEqual(R.run(bad, d / "o.gguf"), 2)


if __name__ == "__main__":
    unittest.main()
