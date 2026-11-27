---
name: llm-memory-sizing
description: "Calculate real LLM memory footprint, KV cache growth, and memory-bandwidth speed ceilings (tokens/s) before buying local AI hardware or renting GPUs. Use whenever the user asks how much RAM or VRAM a model needs, why local LLM generation is slow despite a fast GPU, how DDR5 compares to Apple unified memory, GDDR7, or HBM, or what quantization and context length fit their hardware."
license: MIT
compatibility: "No external dependencies required. Works with Claude Code, Codex, Cursor, OpenCode, and Antigravity."
metadata:
  author: Omar Espinosa
  version: "0.1.0"
  repo: https://github.com/OmarAlex24/skills/tree/main/skills/llm-memory-sizing
  install: npx skills add OmarAlex24/skills --skill llm-memory-sizing
  agents: claude-code, codex, cursor, opencode, antigravity
  tags: llm, ram, vram, hbm, hardware, local-ai, kv-cache
  date: "2026-11-25"
  video: "015-por-que-sube-la-ram"
  description_es: "Calcula cuánta memoria (pesos + KV Cache) y qué ancho de banda necesitas para correr un LLM en local o en servidor GPU. Explica el muro de memoria (DDR5 vs memoria unificada vs GDDR7 vs HBM) y estima el techo real de tokens por segundo antes de comprar hardware."
  summary_es: "Calculadora de memoria, KV Cache y techo de tokens/s según ancho de banda para elegir hardware y cuantización."
---

# LLM Memory & Bandwidth Sizing

Size local AI hardware and GPU instances using the real bottleneck of LLM inference: **memory capacity (weights + KV Cache) and memory bandwidth**, not raw GPU FLOPS.

During autoregressive decoding, a model generates one token at a time and has to re-read **all active weights plus the KV Cache** on every single token. In practice, the chip spends most of its time waiting on memory.

> **Language rule (mandatory):** Always match the language the user is speaking in (for example, reply, ask questions, and label tables in Spanish if the user writes in Spanish). Keep technical units (`GB`, `TB/s`, `FP16`, `Q4_K_M`, `KV Cache`) as-is.

---

## Step 1: Gather the Inputs (Ask Briefly If Missing)

Ask at most 4 short questions if the user did not provide them:

1. **Target model(s):** Parameter count and architecture — dense vs MoE (e.g. `8B dense`, `27B dense`, `70B dense`, or MoE with total vs active params).
2. **Quantization goal:** `Q4` (~4.5–5 bits effective), `Q8` (~8.5 bits), `FP8` (8 bits), or `FP16/BF16` (16 bits).
3. **Context length & concurrency:** Typical prompt/chat length (e.g. `8k`, `32k`, `128k`) and how many concurrent requests (`1` for personal use, `N` for serving).
4. **Hardware budget or existing machine:** What they have or are considering (DDR5 desktop, Apple Silicon unified memory, consumer GPU, workstation GPU, or cloud HBM GPU).

---

## Step 2: Run the Physics Calculations

Always show the math transparently and label assumptions when exact architecture specs (layer count / KV heads) are estimated.

### 1. Model Weights Footprint
```text
weight_GB ≈ total_params_B × (bits_per_weight / 8) × 1.05   # ~5% metadata/overhead
```
Quick reference per billion parameters:
- `FP16 / BF16` (~16 bit): **~2.0 GB / B**
- `FP8 / Q8_0` (~8.5 bit): **~1.05 GB / B**
- `Q4_K_M` (~4.8 bit): **~0.60 GB / B**

*(For MoE models: **capacity** depends on **total** parameters; **decode speed** depends on **active** parameters per token.)*

### 2. KV Cache Footprint
If exact architecture values are known (`layers`, `n_kv_heads`, `head_dim`, `kv_bytes` = 2 for FP16 or 1 for FP8/Q8):
```text
kv_bytes_per_token = 2 × layers × n_kv_heads × head_dim × kv_bytes
kv_GB = (kv_bytes_per_token × context_tokens × concurrency) / 1e9
```
If exact GQA config is unknown, state that it is an estimate and use typical modern GQA ranges:
- `7B–9B` (GQA): ~`0.13 – 0.25 MB / token` (FP16 KV) → `~4 – 8 GB` at `32k`
- `27B–32B` (GQA): ~`0.25 – 0.50 MB / token` (FP16 KV) → `~8 – 16 GB` at `32k`
- `70B` (GQA): ~`0.32 – 0.64 MB / token` (FP16 KV) → `~10 – 20 GB` at `32k`

### 3. Total Memory Required
```text
total_GB = weight_GB + kv_GB + runtime_overhead_GB   # reserve 1.5–4 GB for OS/activations/buffers
```
Flag clearly if `total_GB` exceeds VRAM and spills to system DDR5 (which tanks speed to DDR5 bandwidth).

### 4. Memory-Bandwidth Speed Ceiling (Decode)
```text
active_bytes_GB ≈ (active_params_B × bits_per_weight / 8) + kv_GB_read_per_step
max_tokens_per_sec ≈ (memory_bandwidth_GB_s × efficiency) / active_bytes_GB
```
Use realistic efficiency **`0.65 – 0.80`** (never claim 100% of datasheet bandwidth).

### Reference Memory Tiers

| Memory tier | Typical bandwidth | Role & tradeoff |
| --- | --- | --- |
| **Desktop DDR5 (dual-channel)** | `~60 – 100 GB/s` | Cheap capacity, but chokes autoregressive decode on large dense models. |
| **Unified memory (e.g. Apple Silicon / GB10)** | `~200 – 800 GB/s` | High capacity per dollar; solid medium speed for single-user local models. |
| **Consumer GPU (GDDR6X / GDDR7)** | `~900 – 1,800 GB/s` | Very fast decode, limited VRAM capacity (16–32 GB). |
| **Datacenter HBM (HBM3 / HBM3e)** | `~3,300 – 8,000 GB/s` | 3D-stacked next to the GPU; consumes **3–4× more wafer silicon** than DDR5 and suffers higher stacked-die yield loss, driving datacenter demand and DRAM pricing pressure. |

---

## Step 3: Output a Clear Recommendation

Present:
1. **Sizing table:** Weights GB, KV Cache GB at target context, Runtime overhead, Total GB needed.
2. **Speed estimate:** Estimated `tok/s` range on the user's target hardware (and what happens if it spills off GPU into DDR5).
3. **Actionable knobs:**
   - Does `Q4_K_M` vs `Q8` keep it fully in VRAM/unified memory?
   - Does **KV Cache quantization (`Q8_0` / `FP8`)** unlock longer context without spilling?
   - Would an **MoE model** (smaller active parameters per token) double their interactive speed on the same bandwidth?
4. **Honesty check:** Never invent benchmark scores or recommend specific retail hardware listings without stating whether the figures are theoretical physics ceilings vs measured runs.
