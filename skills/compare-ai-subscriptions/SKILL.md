---
name: compare-ai-subscriptions
description: "Compare AI coding subscriptions (Claude, Google AI, ChatGPT/Codex, Cursor, Devin, OpenCode Go, and direct API) by real API-priced value per dollar using verified Priors plan-subsidy data. Use whenever the user asks which AI subscription gives the most value, whether to pay for a direct lab plan vs an intermediary/aggregator vs direct API, compares $20 vs $100 vs $200 tiers, or wants to audit their monthly AI coding spend."
license: MIT
compatibility: "No external dependencies required. Works with Claude Code, Codex, Cursor, OpenCode, and Antigravity."
metadata:
  author: Omar Espinosa
  version: "0.1.0"
  repo: https://github.com/OmarAlex24/skills/tree/main/skills/compare-ai-subscriptions
  install: npx skills add OmarAlex24/skills --skill compare-ai-subscriptions
  agents: claude-code, codex, cursor, opencode, antigravity
  tags: ai-subscriptions, pricing, api, claude, gemini, openai, cursor, devin, opencode, priors
  date: "2026-11-27"
  video: "018-valor-real-suscripciones-ia"
  description_es: "Compara suscripciones de IA (Claude, Google AI, ChatGPT/Codex, Cursor, Devin, OpenCode Go vs. API directa) por su valor real en dólares a precio de API usando datos verificados de Priors, incluyendo el efecto del modelo elegido y la caché."
  summary_es: "Diagnóstico para elegir tu suscripción de IA según su valor real en API por dólar pagado (datos Priors)."
---

# Compare AI Coding Subscriptions (Real API Value per Dollar)

Help developers evaluate AI coding subscriptions against each other — and against direct pay-as-you-go API billing — using verified **API value per dollar** multiples rather than marketing tier names.

> **Language rule (mandatory):** Always match the language the user is speaking in (for example, reply, interview, and build tables in Spanish if the user writes in Spanish). Keep product names, model IDs, prices, and multipliers as-is.

---

## Step 1: Run a 4-Question Spend & Usage Diagnostic

Ask concisely (skip anything the user already told you):

1. **Primary models:** Which frontier or budget models do you actually rely on daily (e.g., Opus 5.5, Fable 5.2, Gemini 4 Neon, GPT-6.2 Astra/Sol, GLM 5.3, Kimi, DeepSeek)?
2. **Monthly budget:** What are you spending today (or willing to spend) — `$10–$20/mo`, `$100/mo`, `$200/mo`, or pay-as-you-go API?
3. **Usage intensity & cache hygiene:** Do you run long coding-agent sessions every day (hitting 5-hour/weekly quotas with high prompt-cache hits), or occasional short chats?
4. **Tooling preference:** Do you care more about raw token subsidy per dollar, or single-billing convenience across multiple model providers?

---

## Step 2: Apply Verified Subsidy Data (Priors, Nov 27, 2026)

Always attribute the dataset explicitly: **Priors (`mypriors.com/subsidies`, collected Nov 27, 2026)**, and always preserve `preliminary`, `legacy`, and `median vs. specific model` distinctions.

### A. Same Model, Same Price — Direct Lab vs. Intermediary

When comparing the **exact same model at the exact same monthly price**, direct plans from Anthropic, Google, and OpenAI deliver **~7.7× to ~35× more API-priced value** than intermediaries that pay API rates behind the scenes:

| Model · Monthly Tier | Direct Lab Plan | Intermediary Plan(s) |
| --- | --- | --- |
| **Opus 5.5** · `$200/mo` | **Claude Ultra**: `66.1×` (`~$13,214` API) | **Devin Max**: `2.7×` (`~$544`) · **Cursor Ultra** *(legacy)*: `1.9×` (`~$375`) |
| **Opus 5.5** · `$20/mo` | **Claude Pro**: `63.8×` (`~$1,276` API) | **Devin Pro**: `6.1×` (`~$123`) · **Droid Pro**: `4.5×` (`~$90`) |
| **Gemini 4 Neon** · `$200/mo` | **Google AI Ultra 20x** (`$199.99`): `48.0×` *(preliminary, 1 user)* | **Devin Max**: `2.2×` (`~$437`) |
| **GPT-6.2 Astra** · `$200/mo` | **ChatGPT Pro 20x**: `15.3×` (`~$3,060` API) | **Devin Max**: `2.0×` (`~$400`) |

### B. Direct Lab Plans & Model-by-Model Spread (`~$200/mo` and Entry Tiers)

Never quote a plan's **median** without noting that older models can pull medians up — always check the exact model the user plans to run:

| Plan | Price | Key Multipliers (API value per `$1`) |
| --- | --- | --- |
| **Claude Ultra** | `$200/mo` | `Opus 5.5`: **`66.1×`** (`~$13,214`) · `Fable 5.2`: **`27.2×`** (`~$5,445`, `-59%` vs. Opus) · plan median: `60.2×` |
| **Claude Max 5x** | `$100/mo` | `Opus 5.5` / `Sonnet 5.5`: **`76.8×`** (`~$7,682`) · plan median: `60.2×` |
| **Claude Pro** | `$20/mo` | `Opus 5.5`: **`63.8×`** (`~$1,276`) · `Opus 5`/`Sonnet 5`: `99.2×` (plan median: `81.6×`) |
| **Google AI Ultra 20x** | `$199.99/mo` | Plan median: **`34.6×`** (`~$6,911`) · `Gemini 4 Neon`: **`48.0×`** *(preliminary, 1 user)* |
| **Google AI Pro** | `$19.99/mo` | Plan median: **`17.3×`** (`~$346`) · `Gemini 4 Neon`: **`20.8×`** *(preliminary, 2 users)* |
| **ChatGPT Pro 20x** | `$200/mo` | Model range: **`15.3×`–`32.3×`** (`GPT-6.2 Astra`: `15.3×`, `GPT-6.2 Sol`: `19.4×`, `GPT-6.1 Sol`: `29.9×`, `GPT-6 Sol`: `32.3×`) |
| **ChatGPT Plus** | `$20/mo` | `GPT-6.2 Astra`: **`7.7×`** · `GPT-6.2 Sol`: **`9.7×`** · plan median: `11.7×` |

### C. Intermediaries, Own Models & Smaller Labs (Where the Rule Has Exceptions)

- **Cursor Ultra *(legacy, `$200/mo`)*:** Only **`1.9×`** on third-party `Opus 5.5`, but **`21.9×`** (`~$4,371`) on its own **`Composer 2.5 Standard`**.
- **OpenCode Go (`$10/mo`):** Plan median **`3.0×`** (`~$30`), but spikes to **`20.0×`** on `GLM 5.3` and **`10.0×`** on `DeepSeek V4.1 Flash` (and `6.0×` preliminary on `Kimi K3.1`).
- **Don't over-generalize "direct lab always wins":** Smaller labs show lower direct multiples (`Kimi Pro $39`: `7.8×` median; `MiniMax Global $22`: `5.6×`; `Z.ai GLM Coding Lite $17.41`: `4.9×`; `Xiaomi MiMo Max $100`: `1.5×`; `Tencent Lite $7`: `1.1×`), `GLM 5.3` yields `20.0×` on OpenCode Go (`$10`) vs. `7.3×` on Z.ai (`$17.41`), and on `Grok 4.7` at `$200` the direct edge is only `1.4×` (`xAI X Ultra 20.2×` vs. `Factory Droid Max 14.3×`).

---

## Step 3: Mandatory Reality Check (Theoretical Ceiling Caveat)

Never present `66.1×` or `$13,214` as guaranteed value. Always explain **Priors' assumptions**:
1. **Quota exhaustion:** Assumes you consistently utilize your **5-hour and weekly quotas** across a full **4-week monthly pool**.
2. **97% prompt-cache hit rate:** The standard workload assumes **97% cache reads** (realistic for long coding-agent sessions with good cache hygiene, NOT for short uncached chats or frequent mid-session `/compact`). Fewer cache hits burn your quota much faster.
3. **Model choice inside the same plan matters:** Switching from `Opus 5.5` (`66.1×`) to `Fable 5.2` (`27.2×`) inside `Claude Ultra` cuts your effective subsidy by more than half (`-59%`).

---

## Step 4: Deliverable

Return a short, concrete recommendation in the user's language:
1. **Recommended plan split** for their budget and target models (e.g., direct lab subscription for heavy daily frontier models like Opus/Neon/GPT-6.2; optional low-cost multi-model plan or direct API only for burst/background/lightweight tasks).
2. **When direct API actually makes sense:** Light or sporadic usage where you never exhaust a `$20` plan, automated CI/headless pipelines where subscriptions aren't permitted, or strict zero-data-retention API requirements.
3. **Two habits to capture the real subsidy:** Keep prompt cache warm (pair with `context-cache-hygiene`) and reserve lower-subsidy models (like `Fable 5.2` or `GPT-6.2 Astra`) for tasks that actually need them.
