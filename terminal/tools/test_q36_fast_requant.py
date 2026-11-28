"""tools/q36_fast_requant.py: IQ4_XS against ggml's scalar loop, the IQ4_XS -> IQ4_NL rewrite keeping every code and value,
and a whole conversion of a small synthetic qwen35moe GGUF.  No GPU, no download.

    python -m unittest tools.test_q36_fast_requant
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
import q36_fast_requant as F  # noqa: E402
from gguf_reader import GGUFFile  # noqa: E402
from test_q36_mtp_requant import _s, random_blocks, write_gguf  # noqa: E402

KV = [-127, -104, -83, -65, -49, -35, -22, -10, 1, 13, 25, 38, 53, 69, 89, 113]


def f16(b: bytes) -> float:
    return float(np.frombuffer(b, "<f2")[0])


def ref_iq4_xs(blk: bytes) -> list[float]:
    """ggml-quants.c dequantize_row_iq4_xs, one block."""
    d = f16(blk[0:2])
    scales_h = struct.unpack("<H", blk[2:4])[0]
    scales_l, qs = blk[4:8], blk[8:136]
    y = []
    for ib in range(8):
        ls = ((scales_l[ib // 2] >> 4 * (ib % 2)) & 0xF) | (((scales_h >> 2 * ib) & 3) << 4)
        dl = d * (ls - 32)
        q = qs[16 * ib:16 * ib + 16]
        y += [dl * KV[q[j] & 0xF] for j in range(16)] + [dl * KV[q[j] >> 4] for j in range(16)]
    return y


def iq4_xs_blocks(rng, n: int) -> np.ndarray:
    b = random_blocks(rng, n, 136, [0])
    b[:, 0:2] = (rng.uniform(1e-4, 2e-2, n)).astype("<f2").view(np.uint8).reshape(-1, 2)   # a realistic d
    return b


class Formats(unittest.TestCase):
    def test_iq4_xs_matches_ggml(self):
        rng = np.random.default_rng(1)
        b = iq4_xs_blocks(rng, 50)
        got = F.dequant_iq4_xs(b).reshape(50, 256)
        for i in range(50):
            np.testing.assert_allclose(got[i], ref_iq4_xs(b[i].tobytes()), rtol=0, atol=0)

    def test_iq4_nl_keeps_every_code_and_value(self):
        rng = np.random.default_rng(2)
        b = iq4_xs_blocks(rng, 200)
        nl = F.iq4_xs_to_iq4_nl(b)
        self.assertEqual(nl.shape, (1600, 18))
        # the codes are copied byte for byte, eight 16-byte groups a block
        np.testing.assert_array_equal(nl[:, 2:18].reshape(200, 128), b[:, 8:136])
        x, y = F.dequant_iq4_xs(b).reshape(200, 256), F.dequant_iq4_nl(nl).reshape(200, 256)
        # the only change: the 32-value scale d * (ls - 32) rounded to fp16, <= 2^-11 of it (and a value <= 127 of the scale)
        scale = np.abs(F.iq4_xs_scales(b)).repeat(32, 1)
        self.assertTrue(np.all(np.abs(x - y) <= scale * 127 * 2.0 ** -11 + 1e-12))
        self.assertLess(np.abs(x - y).max() / np.abs(x).max(), 1e-3)

    def test_zero_scale(self):
        b = np.zeros((3, 136), np.uint8)
        self.assertTrue(np.all(F.dequant_iq4_nl(F.iq4_xs_to_iq4_nl(b)) == F.dequant_iq4_xs(b)))


class WholeFile(unittest.TestCase):
    E, FF, EMB = 2, 256, 512        # tiny: 2 experts, gate/up [512, 256, 2], down [256, 512, 2]

    def make(self, d: pathlib.Path, layers, dup_key=True) -> pathlib.Path:
        rng = np.random.default_rng(3)
        geom = {12: 144, 13: 176, 22: 82, 23: 136, 20: 18, 21: 110}
        f16_at = {12: [0, 2], 13: [0, 2], 22: [0], 23: [0], 20: [0], 21: [0]}

        def blocks(typ, n_vals):
            if typ == 23:
                return iq4_xs_blocks(rng, n_vals // 256).tobytes()
            be = 32 if typ == 20 else 256
            return random_blocks(rng, n_vals // be, geom[typ], f16_at[typ]).tobytes()

        kv = [("general.architecture", 8, _s("qwen35moe")),
              ("qwen35moe.block_count", 4, struct.pack("<I", len(layers))),
              ("qwen35moe.nextn_predict_layers", 4, struct.pack("<I", 1)),
              ("strata.q36.mtp_requant", 8, _s("first pass")),
              ("tokenizer.ggml.tokens", 9, struct.pack("<IQ", 8, 2) + _s("a") + _s("b"))]
        if dup_key:
            kv.append(("strata.q36.mtp_requant", 8, _s("second pass")))   # what q36_mtp_requant's two passes leave
        t = [("token_embd.weight", [self.EMB, 4], 0, rng.normal(size=self.EMB * 4).astype("<f4").tobytes())]
        for layer, (g, u, dn) in enumerate(layers):
            n = self.EMB * self.FF * self.E
            t.append((f"blk.{layer}.ffn_gate_exps.weight", [self.EMB, self.FF, self.E], g, blocks(g, n)))
            t.append((f"blk.{layer}.ffn_up_exps.weight", [self.EMB, self.FF, self.E], u, blocks(u, n)))
            t.append((f"blk.{layer}.ffn_down_exps.weight", [self.FF, self.EMB, self.E], dn, blocks(dn, n)))
        t.append(("output_norm.weight", [self.EMB], 0, np.ones(self.EMB, "<f4").tobytes()))
        p = d / "in.gguf"
        write_gguf(p, kv, t)
        return p

    def test_converts_the_iq4_xs_downs_only(self):
        with tempfile.TemporaryDirectory() as td:
            d = pathlib.Path(td)
            # layer 0: UD-IQ3_S's IQ2_S / IQ4_XS; layer 1: IQ2_S / Q6_K-like already fast (Q5_K here); layer 2: the MTP block's Q4_K / Q5_K
            src = self.make(d, [(22, 22, 23), (22, 22, 13), (12, 12, 13)])
            self.assertEqual(F.check(src)[0], 1)
            out = d / "out.gguf"
            r = F.run(src, out)
            self.assertEqual((r["converted"], r["slow"]), (1, []))
            self.assertEqual(F.check(out)[0], 0)
            a, b = GGUFFile(src), GGUFFile(out)
            self.assertEqual([t.name for t in a.tensors], [t.name for t in b.tensors])
            types = {t.name: t.type_id for t in b.tensors}
            self.assertEqual(types["blk.0.ffn_down_exps.weight"], 20)
            self.assertEqual(types["blk.0.ffn_gate_exps.weight"], 22)
            self.assertEqual(types["blk.1.ffn_down_exps.weight"], 13)
            # metadata: the duplicated key once (its last value), this tool's note, the rest kept
            self.assertEqual(b.metadata["strata.q36.mtp_requant"], "second pass")
            self.assertIn("blk.0.ffn_down_exps.weight: IQ4_XS -> IQ4_NL", b.metadata[F.KEY])
            self.assertEqual(b.metadata["tokenizer.ggml.tokens"], ["a", "b"])
            _head, spans, _end = F._kv_spans(out)
            keys = [k for k, _v in spans]
            self.assertEqual(len(keys), len(set(keys)))
            # every unchanged tensor byte for byte
            ra, rb = src.read_bytes(), out.read_bytes()
            for ta, tb in zip(a.tensors, b.tensors):
                if ta.name == "blk.0.ffn_down_exps.weight":
                    continue
                n = F._nbytes(ta.type_id, ta.shape)
                self.assertEqual(ra[a.data_start + ta.offset:][:n], rb[b.data_start + tb.offset:][:n], ta.name)
            # the converted one: its values
            ta = next(t for t in a.tensors if t.name == "blk.0.ffn_down_exps.weight")
            tb = next(t for t in b.tensors if t.name == "blk.0.ffn_down_exps.weight")
            x = F.dequant_iq4_xs(np.frombuffer(ra[a.data_start + ta.offset:][:F._nbytes(23, ta.shape)], np.uint8))
            y = F.dequant_iq4_nl(np.frombuffer(rb[b.data_start + tb.offset:][:F._nbytes(20, tb.shape)], np.uint8))
            self.assertLess(np.abs(x - y).max() / np.abs(x).max(), 1e-3)

    def test_deterministic(self):
        with tempfile.TemporaryDirectory() as td:
            d = pathlib.Path(td)
            src = self.make(d, [(22, 22, 23), (12, 12, 13)])
            F.run(src, d / "a.gguf")
            F.run(src, d / "b.gguf")
            self.assertEqual((d / "a.gguf").read_bytes(), (d / "b.gguf").read_bytes())

    def test_q4_k_down_becomes_q5_k_and_unconvertible_layers_are_reported(self):
        with tempfile.TemporaryDirectory() as td:
            d = pathlib.Path(td)
            # layer 0: a Q4_K down (exact to Q5_K); layer 1: an IQ3_S down (no value-keeping conversion: left, reported)
            src = self.make(d, [(22, 22, 12), (22, 22, 21), (12, 12, 13)], dup_key=False)
            r = F.run(src, d / "out.gguf")
            self.assertEqual((r["converted"], r["slow"]), (1, [1]))
            types = {t.name: t.type_id for t in GGUFFile(d / "out.gguf").tensors}
            self.assertEqual(types["blk.0.ffn_down_exps.weight"], 13)
            self.assertEqual(types["blk.1.ffn_down_exps.weight"], 21)

    def test_nothing_to_do_writes_nothing(self):
        with tempfile.TemporaryDirectory() as td:
            d = pathlib.Path(td)
            src = self.make(d, [(22, 22, 13), (12, 12, 13)])
            self.assertEqual(F.check(src)[0], 0)
            self.assertEqual(F.run(src, d / "out.gguf")["converted"], 0)
            self.assertFalse((d / "out.gguf").exists())

    def test_not_qwen36(self):
        with tempfile.TemporaryDirectory() as td:
            p = pathlib.Path(td) / "x.gguf"
            write_gguf(p, [("general.architecture", 8, _s("llama"))], [("a", [32], 0, b"\0" * 128)])
            self.assertEqual(F.check(p)[0], 2)


if __name__ == "__main__":
    unittest.main()
