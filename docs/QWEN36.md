# Qwen3.6-35B-A3B: pictures, several requests at once and speed

This page is for people who run [Qwen3.6-35B-A3B](https://huggingface.co/Qwen/Qwen3.6-35B-A3B) (35B mixture of
experts, 3B active, 256 experts, top-8) with Strata and want to know how pictures, parallel requests and the prompt
chunk behave. For sizes and memory, see [MODELS.md](MODELS.md).

Strata runs [Unsloth's GGUFs with the MTP layer](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-MTP-GGUF)
(UD-Q4_K_XL, UD-Q6_K_XL, Q8_0, and UD-IQ3_S after a conversion) on its own engine path (`engine/src/qwen35`; `strata` switches to it from the file's
architecture). It runs on NVIDIA and AMD cards. The Intel Arc and Mac engines do not run it.

## Quick start

Pick it in the app's model list, in `strata launch` or in setup:

```sh
strata launch --family qwen36 --model ud-q4_k_xl
strata launch --family qwen36 --model ud-q4_k_xl --vision on --parallel 2
```

| Option | Effect |
| --- | --- |
| `--vision on\|off\|gpu\|cpu` | Terminal: pictures and which reader. Source setup uses `--vision yes\|no\|gpu\|cpu` and `--vision-tokens N`. |
| `--parallel N` | How many requests are answered at once, 1 to 8. Source setup has the same option. |
| `--prefill 512` | Engine flag in the config's `args`, not a `strata launch` option: the prompt chunk size ([Prompt chunk](#prompt-chunk)). |

## 8 GB cards: what you get by default (0.2.13.2)

On an NVIDIA card with 8 GB of VRAM or less and 24 GB of RAM or more, `strata launch` recommends Qwen3.6 UD-IQ3_S
and lists it first. Setup then writes these settings without being asked:

| Setting | Value | Why |
| --- | --- | --- |
| Size | UD-IQ3_S (converted once after the download) | The only size whose experts fit 32 GB of RAM beside Windows |
| Context | 128K | As every Qwen3.6 size |
| Conversation memory | 8-bit (`--kv int8`, the engine's `--kv q8`) | 128K in fp32 does not fit 8 GB |
| Conversation checkpoints | `--prompt-cache 6` | An agent's next turn is not read from the start |
| Model file pages | `STRATA_Q36_RELEASE_FILE_PAGES=1` | About 8.8 GB of RAM goes back to Windows after loading |

On a Windows PC with such a card, the whole path is:

```powershell
irm https://github.com/ILG2021/Strata/releases/latest/download/install.ps1 | iex
strata launch
```

`--kv fp16` keeps the fp32 memory (and needs `--context 32k`); any other choice stays yours. Cards with more VRAM get
the same defaults as before. Measured on an RTX 4060 Laptop (8 GB), 32 GB of RAM, Windows 11, 128K, 8-bit memory:
26-31 tokens/s; an opencode turn after the first read 22 new tokens in 0.3 s (15,799 reused) instead of the whole
13,098-token prompt in 33 s. The experts run on the CPU on this card, so the CPU is busy and the GPU about half loaded
while it answers. The sections below have the details and older measurements.

## A smaller file: UD-IQ3_S (8 GB cards, 32 GB of RAM)

Unsloth's [UD-IQ3_S](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-MTP-GGUF) (15.3 GB) is the smallest size. On an
8 GB card it is the default (above). To ask for it elsewhere:

```sh
strata launch --family qwen36 --model ud-iq3_s
```

Setup downloads the file, checks its SHA-256, converts its MTP block once (a few minutes), checks the converted file
and removes the download. At the peak it needs about 31 GB of free disk (the download and the converted copy); after
that the converted 15.9 GB file stays.

Why it needs the conversion: its MTP block (layer 40) keeps its experts as Q2_K and Q4_K. The engine has no GPU kernels
for those, and it always loads the MTP block, so it refuses the file as it is. `tools/q36_mtp_requant.py`
rewrites only those three tensors as Q8_0 and copies everything else byte for byte. The MTP block only proposes draft
tokens, and the main model checks every draft, so a greedy answer is the main model's answer.

Other IQ3 files do not run, with or without the conversion. Their main layers use expert types the engine has no GPU
kernels for. That covers UD-IQ3_XXS from the MTP repository (IQ3_S down projections) and every file from
`unsloth/Qwen3.6-35B-A3B-GGUF`, which has no MTP block (the engine stops with "missing
qwen35moe.nextn_predict_layers"). `--check` tells you which case a file is:

```sh
python tools/q36_mtp_requant.py --check Qwen3.6-35B-A3B-UD-IQ3_S.gguf
python tools/q36_mtp_requant.py Qwen3.6-35B-A3B-UD-IQ3_S.gguf Qwen3.6-35B-A3B-UD-IQ3_S-strata.gguf
```

The conversion makes the file 0.5 GB bigger. It is deterministic, so setup pins the result too. SHA-256 at the pinned
revision `5bc3e238`: the download `ab639a7f330f96c47d3e6c2dd2d6445182e7b763e17e6048dc850a71bbc9f27f` (15,346,432,288
bytes), the converted file `dc3f829f974e3063cfef851b0fe5ffa3785987ad9d0d6f8567042c5344ebf07b` (15,874,914,752 bytes).

Without `--context`, `strata launch` takes 128K, as for every Qwen3.6 size. On an 8 GB card that does not start: the
fp32 cache alone needs about 5.6 GiB at 128K, and the engine stops with "not enough VRAM left for the hybrid experts'
buffers and slots (1664 MiB needed, 0 MiB free ...)". `--context 32k` starts.

64K starts only without the MMQ prompt path. Most of those 1,664 MiB is a staging pair for reading prompts, two copies
of the largest layer's experts. The converted MTP block is that largest layer (816 MiB as Q8_0). At 64K, 434 MiB is
left. `STRATA_Q36_NO_MMQ=1` drops the staging pair, and then 64K fits. Prompts are read about 4 times slower:

```sh
strata launch --family qwen36 --model ud-iq3_s --context 64k --set STRATA_Q36_NO_MMQ=1
```

> **Measured on:** the same PC and build as below, greedy, one request at a time, the two contexts run one after the
> other on 2026-11-10.

| | 32K (MMQ) | 64K (`STRATA_Q36_NO_MMQ=1`) |
| --- | ---: | ---: |
| Decode, 114 tokens, with drafts | 44.3 tokens/s | 41.1 tokens/s |
| Prompt of 2,936 tokens | 372 tokens/s | 94 tokens/s |
| Prompt of 25,483 tokens | 391 tokens/s (65 s) | 99 tokens/s (258 s) |
| Decode after that prompt | 10.1 tokens/s | 10.2 tokens/s |

`strata launch --model-path` does not take Qwen3.6 files yet (it accepts Flash-Next files only). The desktop app lists
the size from the same table; its install was not run.

> **Measured on:** RTX 4060 Laptop GPU 8 GB, 32 GB of RAM, Windows 11, engine 0.1.59 (CUDA 13 package), the converted
> UD-IQ3_S, context 32K, one request at a time, a 114-token answer; started by hand and then by `strata launch` (39.8
> tokens/s with drafts on the first request after that start, the same 75 of 78 drafts and the same tokens). Every expert ran from RAM (0 of 256 per layer in VRAM). The engine
> used 6.8 GB of VRAM and 19.6 GB of RAM.

| Request | Speed |
| --- | ---: |
| Decode, greedy with MTP drafts (75 of 78 drafts accepted) | 46 tokens/s |
| Decode without drafts | 33 to 35 tokens/s |
| Prompt of 2,828 tokens | 348 tokens/s |

The drafts run only for a greedy request without penalties. `temperature: 0` is enough: the server then leaves out the
model card's `presence_penalty`, and `top_p` / `top_k` do not matter. A presence, frequency or repetition penalty that the
request, the run config's `sampling` block or the shared Chat settings name themselves still turns the drafts off. The
engine's log says how many drafts a request got (`drafts accepted X of Y`).

## 128K on an 8 GB card: the 8-bit cache (the default on 8 GB cards, opt-in elsewhere)

The engine keeps the attention cache in fp32: 5.6 GiB at 128K. `--kv q8` (engine option; `strata launch --kv int8`
asks for it) keeps it in 8 bits instead: 256 int8 values and 8 fp32 scales per row, one scale per 32 values, as
ggml's q8_0. That is 288 bytes per row instead of 1,024, 1.5 GiB at 128K. The default stays fp32, unchanged.

```sh
strata launch --family qwen36 --model ud-iq3_s --kv int8 --context 128k
```

It needs an engine with this option (source version 0.1.59.1 and later). Engine 0.1.59 and older do not have it: they
say "ignoring --kv" and keep fp32, and 128K does not start on 8 GB.

On 8 GB it also needs the compact MTP block. The prompt path keeps two staging copies of the largest layer's experts
in VRAM. As Q8_0 the MTP block is that layer (816 MiB), and 128K stops 386 MiB short. Setup therefore makes UD-IQ3_S in
two pinned steps: the download becomes `...-UD-IQ3_S-strata.gguf` (the MTP block as Q8_0), which becomes
`...-UD-IQ3_S-compact.gguf` (Q4_K gate / up, Q5_K down: 475 MiB). Each file's SHA-256 is checked before the next step,
and the earlier files are removed. A PC that has the first file from an earlier setup gets only the second step, with no
download. By hand:

```sh
python tools/q36_mtp_requant.py --mtp-format q8_0 Qwen3.6-35B-A3B-UD-IQ3_S.gguf Qwen3.6-35B-A3B-UD-IQ3_S-strata.gguf
python tools/q36_mtp_requant.py --recompact Qwen3.6-35B-A3B-UD-IQ3_S-strata.gguf Qwen3.6-35B-A3B-UD-IQ3_S-compact.gguf
```

**An engine built on this PC.** `strata launch` takes the newest engine package in the component folder that fits the
PC and whose files match its manifest's SHA-256. An unsigned package is accepted unless
`STRATA_REQUIRE_SIGNED_COMPONENTS` is set. A package made from a local build (the manifest of the release package, with
this build's version, files and hashes and no signature) in
`%LOCALAPPDATA%\Strata\components\engine\<version>-windows-x86_64-cuda-cuda13-local` is therefore used by
`strata launch`. Removing that folder goes back to the release engine.

> **Measured on:** RTX 4060 Laptop GPU 8 GB, 32 GB of RAM, Windows 11, this source built with CUDA 13.0.2 for sm_89
> (setup's local-build options), the compact UD-IQ3_S, one request at a time, greedy, 2026-11-10. 128K started with
> 1.25 GiB of VRAM left after the weights and the cache, 0.91 GiB of staging, 6.9 GB of VRAM in use. The 32K column is
> engine 0.1.59 with fp32 the same day.

| | 32K, fp32 | 128K, `--kv q8` |
| --- | ---: | ---: |
| Decode, 114 tokens, with drafts | 44.3 tokens/s | 46.9 tokens/s |
| Prompt of about 3,000 tokens | 372 tokens/s | 395 tokens/s |
| Prompt of about 25,500 tokens | 391 tokens/s | 403 tokens/s |
| Decode after that prompt | 10.1 tokens/s | 29.2 tokens/s |
| Prompt of 101,212 tokens | does not fit | 302 tokens/s (335 s), then 12.3 tokens/s |
| Prompt of 121,355 tokens | does not fit | 272 tokens/s (446 s), then 12.0 tokens/s |

Decode after a long prompt is faster: every token reads the whole cache, and the cache is 3.6 times smaller.

Both long prompts had one sentence near their start ("the maintenance code ... is 7341-PURPLE-RIVER") and asked for it
at the end. Both answers were exactly `7341-PURPLE-RIVER`.

How close the answers stay to fp32 (UD-IQ3_S, context 8K):

- The default path is unchanged: the 10 parity prompts give the same 128 greedy tokens with and without this change
  (`q36_solo_gate.py` + `q36_cmp_gate.py`, the build before the change against the build after it).
- With `--kv q8` the 10 prompts' greedy answers are the same for 1 of 10 over 128 tokens. They part at close choices
  ("The wind at Blackwood Point" against "The wind off the North Atlantic"; "Logical Explanation" against "Logical
  Deduction"); the texts stay coherent.
- Fed the fp32 answers (5 prompts, 21 to 65 steps each), the mean KL divergence from fp32 is 6.0e-4 to 7.7e-3 per
  prompt (3.0e-3 over the five) and the top token is the same at 95.4% to 100% of the steps. The same fp32 run twice
  gives the same bytes, so the difference is the cache's.

## Conversation checkpoints (opt-in)

Without them this engine reuses a held conversation only when the next prompt continues it token for token. Agents
such as opencode break that on almost every turn: the same model writes a short title between two turns, and the reply
comes back without its thinking. Then the whole prompt is read again.

`--prompt-cache N` in the config's `args` (off by default on this path; one request at a time, not with `--batch`)
keeps up to N checkpoints of the recurrent state in RAM, 63 MiB each for Qwen3.6-35B-A3B: one at the end of the system
prompt (when that is 2,048 tokens or more, `--prompt-cache-root`) and one at the start of the newest turn. A prompt
with another start (the title request) moves the conversation out: its cache cells go to RAM only as they are about to
be overwritten (44 KiB a token), and the next turn of that conversation brings it back.

Each save first checks that the available RAM stays above a floor (`STRATA_Q36_CKPT_FLOOR_MIB`, default 512); a save
that would go under it is skipped and the log says so once. `0` turns the check off, and a failed allocation still
only skips the save. The engine's pinned experts count against Windows' "available" figure, so on a 32 GB PC that
runs UD-IQ3_S the default floor can skip every save.

Measured on an RTX 4060 Laptop (8 GB), 32 GB RAM, Windows 11, UD-IQ3_S compact, 32K, `--prompt-cache 3`,
`STRATA_Q36_CKPT_FLOOR_MIB=0`, one sequence of opencode-like requests with a 4.4K-token system prompt, greedy, 2026-11-10:

| Request | Before | With checkpoints |
| --- | --- | --- |
| Turn 2 after a title request, thinking not sent back | 4,421 read, 13.9 s | 4,363 reused + 58 read, 2.2 s |
| Turn 3 | 4,440 read, 16.2 s | 4,363 reused + 77 read, 4.8 s |
| A new chat with the same system prompt | 4,370 read, 12.9 s | 4,347 reused + 23 read, 1.8 s |

Decode stayed at 30-32 tok/s. The "before" run shared the CPU with a compile, so its times are not a clean baseline;
the token counts are. A 6,385-token prompt read cold, then again from its checkpoint (live, and after another prompt
had moved it out), gave the same 150 greedy tokens all three times. A resumed request reads its last part as a short
chunk, and short chunks run on other kernels, so its greedy text can part from a cold read of the same prompt at a
close choice. In the sequence above, turns 2 and 3 and the new chat did. Not measured: other cards, `--kv q8`, Linux, and
the default path against the previous build (code reading: without `--prompt-cache` the read is the same single call).

## The model file's pages after loading (opt-in)

The engine maps the GGUF and copies every weight out of it while it loads: to the GPU, or into the experts' own pinned
host memory. Nothing reads the mapping after that, but the pages the load read stay in the engine's working set, and
Windows does not count them as available RAM. `STRATA_Q36_RELEASE_FILE_PAGES=1` (in the config's `"env"`) takes them
out of the working set once the experts are placed (`VirtualUnlock` on Windows, `madvise(MADV_DONTNEED)` on Linux). The
mapping stays valid; a later read would fault the page back in.

Measured on an RTX 4060 Laptop (8 GB), 32 GB RAM, Windows 11, UD-IQ3_S compact, 128K, `--kv q8`, 2026-11-10: the engine's
working set went from 19,201 to 12,732 MB and the available RAM from 4,446 to 10,497 MB (other programs as they were,
not controlled). A 6,374-token prompt read at 383.6 and 380.2 tok/s and decoded at 29.5 and 30.7 tok/s, one run each;
its 136 greedy tokens were the same. Not measured: Linux, the all-in-VRAM placement, a start while RAM is short.
Where the rest of the engine's private memory goes: 12.55 GiB is the experts' pinned copy; the 6.8 GiB of
write-combined blocks a memory map shows are Windows' reservation for the GPU allocations (commit charge, 0.01 GiB in
RAM).

## Pictures

The vision encoder is Unsloth's `mmproj-F16.gguf` (0.9 GB, pinned revision, SHA-256 checked by setup): a 27-layer ViT
with a 2x2 merger, the same projector family as the Flash-Next models' (`qwen3vl_merger`; only its output width
differs: 2048 here, 2560 there). Strata runs it with the same helper (`strata-vision`), so the
encoder choices are the Flash-Next ones ([Images](DETAILS.md#images-vision)).

Pictures are on by default, by the same rule as for every model on NVIDIA and AMD cards:

- The CPU reader runs under 24 GB of graphics memory. It takes a few seconds per picture and no VRAM.
- The card's reader runs from 24 GB (GPU encoder, about 1.2 GB of VRAM at up to 1,024 image tokens). On AMD it is
  `strata-vision-hip`, with the CPU reader as its fallback.

Your explicit choice is kept, with a note. A picture becomes up to 1,024 tokens of the context (the CPU default is 300).
The engine puts the encoder's rows where the prompt has `<|image_pad|>` tokens and gives every row its 2-D position,
interleaved M-RoPE as llama.cpp does for this model (rotary sections 11 / 11 / 10).

Pictures work with several requests at once, with the MTP drafts and with the conversation cache. The same conversation
sent again continues from the held state when its pictures are the same (matched by the server's key for each
picture). A different picture starts that conversation again.

> **Measured on:** RTX 3060 12 GB (CUDA) and an R9700 box (32 threads) and a 3060 box (10 threads), UD-Q4_K_XL, Strata
> 0.1.45.

| Encoder | Time per picture (640x400 = 260 tokens / 800x450 = 350 tokens) | VRAM |
| --- | --- | --- |
| GPU, RTX 3060 | 0.10 s / 0.15 s | 1,179 MiB at up to 1,024 tokens (1,337 MiB at 2,048), CUDA context included |
| CPU, 32 threads (R9700 box) | 0.9 s / 1.1 s | none |
| CPU, 10 threads (3060 box) | 1.6 s / 2.1 s | none |

## Several requests at once

`"parallel": N` in the model's config (`strata-qwen36-<size>.json`) or `--parallel N` makes the engine keep N
conversations open (`--batch N`, up to 8) and decode them together. Every window carries one token of each
conversation, so the dense weights, the head and every routed expert that conversations share are read once for all of
them. The server speaks the same engine protocol as for Flash-Next ([BATCHING.md](BATCHING.md)).

A new request waits only for the read of its own prompt, which runs between the decode windows of the others. A
conversation continues in the slot that holds its start, or the engine copies the longer held start from another slot.
A request that runs alone (the solo path, with its MTP drafts) moves into a batch slot when another arrives, and back
when it is alone again, and gives the same text either way.
`STRATA_Q36_READ_WINDOWS=4` lets the decoding slots produce more tokens during a long prompt read, at the cost of a
slower read. The default is one decode window per chunk.

**MTP drafts.** A request that has the engine to itself keeps its MTP drafts. With several requests the batch window has
no drafts unless `--batch-mtp` is in the config's `args` (opt-in). Each slot's window then also carries the proposal its
MTP block made, one per slot, up to the rows to spare in the 8-row window.

**What a slot costs.** Each slot keeps its own cache in VRAM: 1.5 GB at a context of 32K (fp32 keys and values of the 10
attention layers and the MTP block, 45 KB per token) and 0.07 GB of recurrent state. Setup writes the context for one
conversation, so N slots take N times that from the room the experts would have. On a card that does not hold every
expert (12 and 16 GB, the hybrid mode) the expert slots lose that room, and a batch reads more distinct experts from RAM.

Setup offers `--parallel` where the sessions do not eat the experts' room, says the price in the same breath and asks
"How many requests at once?" Enter keeps one at a time, and any number you give is kept.

| Card type | Slots setup offers |
| --- | --- |
| Every expert still fits | Up to 3 to 4 (3 on a 32 GB card at 32K) |
| Hybrid mode | The count whose sessions take at most 35% of the room the experts would have. 12 GB: 4 slots at 8K, none at 32K. 16 GB: 2 slots at 32K. |

The engine says what the sessions take before it allocates them and refuses, with the numbers, a count that cannot fit.

In the hybrid mode the text of a request can differ a little between running alone and running beside others. The
experts that sit on the GPU or on the CPU change with the routing of all the requests, and the two compute with
different rounding. With the slot tables fixed (`STRATA_Q36_FIXED_SLOTS=1`, a test setting) every slot equals its solo
run there too.

## Prompt chunk

The MoE prompt kernels read every expert once per chunk, so a bigger chunk feeds them more rows per expert. With every
expert in VRAM the engine takes the largest of 4096 / 2048 / 1024 that fits beside the experts, the 0.77 GiB reserve
and the sessions' caches.

| Situation | Chunk |
| --- | --- |
| Every expert in VRAM, 8K to 64K context | 4096 |
| Every expert in VRAM, 100K context | 2048 |
| Every expert in VRAM, 131K context | 512 |
| `--batch 2..4` | 1024 at most, so the other slots are not held for a whole chunk |
| `--batch 8` | 512 |
| Hybrid mode | 2048; 1024 or 512 on a card with 7.5 or 5.5 GiB free |

In the hybrid mode a bigger chunk takes expert slots (an RTX 3060 at chunk 4096 read prompts 5% faster and decoded 13%
slower). `--prefill 512` (or `STRATA_Q36_CHUNK=512`) gives the 512 size, and then the text is the base engine's, bit
for bit. The chunk size changes the GEMM tiles the BLAS picks and with them the last bits of the prompt state. This is
the size of the llama.cpp CPU-against-HIP difference on the same file, not a quality loss. A prompt shorter than the
chunk (every chat turn after the first) is one chunk either way.

## Speed and exactness

Every change on the decode path gives the old kernels' bits. `STRATA_Q36_VERIFY=1 strata ... --no-graph` runs the old
kernel beside each new one on the real activations and compares them bit for bit. `STRATA_Q36_OLD_KERNELS=1` switches
the new kernels off. Gate/up for Q4_K experts uses the V2K kernels (`STRATA_EXPERT_V2K`, the default on gfx12).

> **Measured on:** AMD Radeon AI PRO R9700 32 GB (HIP gfx1201), UD-Q4_K_XL, Strata 0.1.45 against the engine before it,
> 5 interleaved pairs, medians; llama.cpp 972b5fc HIP on the same file (`-fa 1`).

| | Before | 0.1.45 | llama.cpp |
| --- | ---: | ---: | ---: |
| Decode tg128 | 83.2 tok/s | 117.8 | 81.9 to 82.1 |
| Prompt pp4096 | 3,453 | 6,220 (chunk 4096) | 3,794 (`-ub 2048`) / 3,042 (`-ub 512`) |

More numbers are in [History](#history--older-measurements).

## Limits

- Eight slots at most (the window holds 8 rows). `--batch-mtp` shares those rows between slots and proposals.
- A sampling request in a batch decodes one token per window without proposals.
- `logit_bias` is not available on this engine path. The server refuses a request that has it (as it does with
  `--batch` for Flash-Next).
- A slot that stopped being alone goes back to the solo path only through the server's own hand-over. The MTP block's
  cache has holes for the tokens a slot decoded in batch windows, so the drafts of a later solo stretch are a little
  worse. The text is not affected.
- Intel Arc (SYCL) and Mac do not run this family.

## Testing

The gates are in `tools/qwen35/` and talk to the engine through its serve protocol (no server needed). Run them under
the box's GPU lock.

| Script | Checks |
| --- | --- |
| `q36_solo_gate.py` + `q36_cmp_gate.py` | The 10 parity prompts x 128 greedy tokens through `GEN`, compared with another build's. |
| `q36_batch_gate.py --slots N --waves --long 2500` | Every slot's tokens equal its solo tokens, slots reused, a long prompt read beside decoding slots. |
| `q36_proto_edge.py` | `max_new` 1, `BSTOP`, a busy slot, `STOP` during a prompt read, held-state reuse, sampled requests, the context's end. |
| `q36_interleave_probe.py` | What the decoding slots see while a long prompt is read. |
| `q36_vision_cmp.py` (with `q36_mtmd_dump.cpp` built against llama.cpp) | The picture comparison against llama.cpp. |
| `q36_vision_proto.py` | Pictures through `GENI` / `BGENI` (solo, in a batch, the conversation cache). |
| `q36_vision_serve.py`, `q36_serve_par.py`, `q36_serve_handoff.py` | The same through the server. |
| `q36_par_bench.py` | The aggregate-throughput A/B against `llama-server -np N`. |

## History / older measurements

### Pictures checked against llama.cpp

> **Measured on:** R9700 32 GB (HIP), UD-Q4_K_XL, Strata 0.1.45. llama.cpp's `mtmd` and its own graph, the encoder on the
> CPU on both sides, the same prompt ids, llama.cpp's answer fed to both, logits compared step by step over 24 steps.
> The floor is llama.cpp's CPU backend against its own HIP run.

| Picture and question | Prompt tokens | First token | Mean KL, llama.cpp HIP vs Strata | Floor |
| --- | ---: | --- | ---: | ---: |
| 640x400, text in the image | 288 | same | 0.029 | 0.056 |
| 640x400, list the shapes | 294 | same | 0.035 | 0.039 |
| 800x450, text in the image | 378 | same | 0.021 | 0.031 |
| 800x450, describe the shapes | 381 | same | 0.0005 | 0.0019 |
| 1024x1024, the title (1,024 image tokens, 3 chunks) | 1,042 | same | 0.0022 | 0.0026 |
| two pictures in one request | 655 | differs (a near tie; the floor's KL at this step is 0.16) | 0.014 | 0.022 |

The answers are the same text as llama.cpp's. With the picture options on, a request without pictures gives the same
tokens as without them (10 prompts x 128 greedy tokens).

### Aggregate decode speed, several requests at once

> **Measured on:** same prompts, greedy, 128 new tokens each, wall time from first request to last answer, 5
> interleaved pairs, medians, Strata 0.1.45 with `--batch 8 --mtp 0` against `llama-server -np N`.

| Card | Requests | Strata tok/s | llama.cpp | Ratio |
| --- | ---: | ---: | ---: | ---: |
| R9700 32 GB, UD-Q4_K_XL | 1 | 83.9 | 73.8 | 1.14 |
| | 2 | 173.5 | 107.4 | 1.61 |
| | 4 | 252.0 | 165.0 | 1.53 |
| | 8 | 325.4 | 208.1 | 1.56 |
| RTX 3060 12 GB, hybrid (llama.cpp `-ncmoe 28 -t 8`, the best split of a sweep) | 1 | 64.0 | 41.1 | 1.56 |
| | 2 | 85.1 | 52.5 | 1.62 |
| | 4 | 99.3 | 63.0 | 1.58 |

All pairs were faster for Strata. Every slot's tokens equal the tokens of the same request alone.

### Several requests with the base engine, and with `--batch-mtp`

> **Measured on:** R9700 32 GB, 5 interleaved pairs, Strata 0.1.45 (before the speed work below).

| Requests | `--mtp 0` | `--mtp 2 --batch-mtp` | Ratio |
| ---: | ---: | ---: | ---: |
| 1 | 83.7 tok/s | 134.0 | 1.60 |
| 2 | 173.1 | 207.0 | 1.20 |
| 4 | 251.0 | 275.0 | 1.10 |
| 8 | 324.0 | 320.5 | 0.99 (no row to spare: no proposals) |

> **Measured on:** hybrid cards, UD-Q4_K_XL, medians of 5 interleaved pairs, `--mtp 2`; "together" is the total tokens
> per second of N simultaneous requests against one request at a time with the draft layer.

| Card, context | Slots | One request alone, against 1 slot | N together, against one at a time |
| --- | ---: | ---: | ---: |
| RTX 3060 12 GB, 8K | 2 / 4 / 8 | -3.5% / -4.3% / -12% | 0.99x / 1.15x / 1.10x |
| RTX A4000 16 GB, 32K | 2 / 4 | -10.6% / -29.9% | 1.03x / 0.76x |
| Tesla P100 16 GB, 32K | 2 / 4 | -7% / -23% | 0.98x / 0.81x |

Without the draft layer (`--mtp 0`) the same slots give 1.26x to 1.64x together (3060 at 8K: 4 slots 1.64x for -5.5%
alone). A single request with drafts is already about 1.6x as fast as one without, so on a small card the main gain is
that a second user starts at once. On a card that holds every expert (R9700 32 GB, 8K prompts), 4 slots run 1.45x
one-at-a-time-with-drafts (1.59x with `--batch-mtp`).

### Prompt read beside decoding slots

> **Measured on:** R9700 32 GB, Strata 0.1.45, three decoding slots.

A 3,008-token prompt was read in 0.95 s (3,200 tok/s, 6 chunks). Each decoding slot paused at most 160 ms (one chunk)
and produced 20 tokens meanwhile. With `STRATA_Q36_READ_WINDOWS=4` they produced 65 tokens during a 1.14 s read.

### Speed work in 0.1.45

> **Measured on:** R9700 32 GB (HIP gfx1201), UD-Q4_K_XL, 5 interleaved pairs, 3 repetitions each, medians; base = the
> engine before 0.1.45.

| | Base | 0.1.45 | Ratio |
| --- | ---: | ---: | ---: |
| `--mtp 2`, 10 prompts greedy 128 | 167.7 tok/s | 183.7 | 1.10 |
| 1 / 2 / 4 / 8 requests (`--batch 8 --mtp 0`) | 85.2 / 182.4 / 271.9 / 361.1 | 122.4 / 205.1 / 303.3 / 386.9 | 1.44 / 1.12 / 1.12 / 1.07 |
| Prompt pp4096 at chunk 512 / 1024 / 2048 / 4096 | | 3,453 / 4,786 / 5,766 / 6,223 | |

UD-Q6_K_XL on the same card (every main layer's experts in VRAM, chunk stays 512): decode 80.4 to 106.9 tok/s, pp4096
2,160 to 2,200 (llama.cpp 3,486 at `-ub 2048`, 2,738 at `-ub 512`), `--mtp 2` 154.7 to 167.3. `--chunk 2048` there moves
the experts to the hybrid placement (205 of 256 per layer in VRAM): prompt 3,500 tok/s, decode 94. That is an option,
not the default.

> **Measured on:** RTX 3060 12 GB (CUDA sm_86, 20 threads), UD-Q4_K_XL in the hybrid mode (37 of 256 experts per layer
> in VRAM), Strata 0.1.45.

Decode tg128 58.5 to 59.7 tok/s (+2%), pp2048 1,958 to 2,022 (+3.3%), 10/10 prompts identical, plain and with `--mtp 2`.
llama.cpp 972b5fc CUDA (`-ncmoe 26 -t 8 -ub 2048`): pp2048 1,328, tg128 48 to 52. The GPU part of a token is the dense
Q8_0 at the card's bandwidth and the rest waits for the CPU pool, so only the small kernels' share is gained.

KL against the 512 chunk on six real 1.5K to 3.2K-token documents (48 teacher-forced rows each): chunk 1024 4.0e-3,
2048 4.2e-3, 4096 3.6e-3, top-1 agreement 44 to 48 of 48 rows. Greedy 64 tokens after those documents: the default chunk
gives the base engine's text for 2 of 6, `--prefill 512` for 6 of 6.
