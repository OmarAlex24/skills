---
name: audit-agent-harness
description: "Audit extra frameworks, prompt layers, MCP servers, default skills, and subagent routing stacked on top of a coding agent — using real token/latency mechanisms and verified gentle-ai benchmarks — to decide what to keep and what to strip out. Use whenever the user complains their coding agent feels slow or burns too many tokens, evaluates frameworks like gentle-ai, designs subagent/review rules, or wants a clean minimal setup."
license: MIT
compatibility: "No external dependencies required. Works with Claude Code, Codex, Cursor, OpenCode, and Antigravity."
metadata:
  author: Omar Espinosa
  version: "0.1.0"
  repo: https://github.com/OmarAlex24/skills/tree/main/skills/audit-agent-harness
  install: npx skills add OmarAlex24/skills --skill audit-agent-harness
  agents: claude-code, codex, cursor, opencode, antigravity
  tags: agents, harness, gentle-ai, tokens, latency, subagents, mcp, skills, workflow
  date: "2026-11-27"
  video: "019-frameworks-extra-agentes"
  description_es: "Audita las capas extra que pusiste encima de tu agente (frameworks como gentle-ai, reglas siempre cargadas, MCPs, skills por defecto y subagentes) para detectar qué te está frenando o quemando tokens y quedarte solo con lo que sí paga su costo."
  summary_es: "Auditoría práctica para detectar qué capas extra (reglas, MCPs, skills, subagentes) vuelven lento o caro a tu agente."
---

# Audit Your Agent Harness (Less Default Layers, More Speed)

Help developers diagnose why an AI coding agent feels sluggish or burns excessive tokens when wrapped in extra frameworks, prompt overlays, MCP servers, skill libraries, and automatic review/subagent workflows — and strip the setup down to what genuinely earns its overhead.

> **Language rule (mandatory):** Always match the language the user is speaking in (for example, reply, interview, and build checklists in Spanish if the user writes in Spanish). Keep tool names, file names (`AGENTS.md`, `CLAUDE.md`), and benchmark numbers as-is.

---

## Step 1: Inventory the Active Layers

Inspect the user's current project or ask concisely (skip what you can read directly from the repo/config):

1. **Always-loaded instruction files:** How large are `AGENTS.md`, `CLAUDE.md`, or injected orchestrator routing blocks (`ODD`, personas, style guides)?
2. **Connected MCP servers:** How many MCP servers are active by default (memory servers like `Engram`, docs like `Context7`, code graphs, browser/DB tools), and how often are their tools actually called?
3. **Default skills & review gates:** Are multiple skills auto-loaded or is an automatic review pipeline (`RDD`, multi-judge reviews) firing on routine edits?
4. **Subagent delegation habits:** Does the setup spawn subagents on small fixes or single-file tasks?
5. **Primary pain:** Slow wall-clock time, burning through subscription quotas/API dollars, or regressions on risky changes?

---

## Step 2: Explain the Real Cost Mechanisms (Verified Evidence)

Keep the tone fair, factual, and respectful of open-source harness projects. Use the verified numbers published by **`Gentleman-Programming/gentle-ai` (`README.md`, commit `d64b1c1`, Nov 27, 2026)** — always noting **`n = 1` single runs** and **API-equivalent cost**:

### 1. Why Every Layer Adds Tax
- **Static context tax:** Always-loaded routing cores, persona prompts, MCP tool schemas, and skill registries enter the base context on every turn.
- **Extra turns:** Automatic memory lookups, task-file synchronization, and risk/review steps add round-trips before code is written or closed.
- **Subagent cold-start tax:** As `gentle-ai`'s own README states: *"A subagent costs a fresh session, uncached reads, and a handoff"* and *"spends one to two minutes reading before it writes."*

### 2. Verified Case Study (`Gentleman-Programming/gentle-ai` / Gentle Shell)

| Benchmark (`README.md`, `n = 1`, API-equiv.) | Before / Heavy Routing | After / Comparison | Takeaway |
| --- | --- | --- | --- |
| **3-line bug in one function** *(Gentle Shell: old rules → inline)* | `335 s` · `56 turns` · `$0.339` | **`77 s` · `10 turns` · `$0.105`** *(inline, no subagents)* | **`4.3×` faster**, `5.6×` fewer turns, **`3.2×` cheaper**. That's why `gentle-ai` itself switched to working **inline by default**. |
| **Bug in shared logic** *(Gentle Shell)* | `479 s` · `$0.361` | **`276 s` · `$0.207`** *(1 explorer)* | Narrow read-only exploration beat heavy orchestration. |
| **Large task vs. plain Codex CLI** *(same model, blind review)* | **Gentle Shell (Pi)**: `17.5–17.9 min` | **Codex CLI**: `6.1 min` | Nearly **`3×` slower** wall-clock — **but** Gentle Shell was **accepted on the first round in every cell** and **ranked higher on medium (3/3 runs) and large tasks**. |
| **High-risk data migration** *(Gentle Shell)* | `559 s` · `$0.403` *(needed feedback round)* | **`539 s` · `$0.555`** *(1 independent verifier, accepted 1st round)* | Independent verification cost more up front, but avoided a correction round on high-risk work. |

### Fairness Rule
Never attack `gentle-ai` or claim extra tooling is *never* useful: `gentle-ai` is open source (MIT), free, publishes its own numbers honestly (including the `~3×` gap vs. Codex CLI), and already retired SDD and switched to inline-by-default because of those measurements. The lesson applies to **any** harness stacked on top of modern agents.

---

## Step 3: Apply the "Start Clean" Ladder

Recommend an additive architecture instead of installing an all-in-one framework on day one:

1. **Level 0 — Clean base agent:** Use the agent natively without extra orchestration wrappers for routine edits, small bugs, and single-module features.
2. **Level 1 — Concise project rules (`AGENTS.md` / `CLAUDE.md`):** Keep only repo-specific build/test commands, hard invariants, and gotchas the model would otherwise miss. Trim generic engineering lectures.
3. **Level 2 — On-demand skills & MCPs:** Enable a skill or MCP server **only** when a recurring friction proves it pays for its context cost. Disable unused MCP servers so their schemas don't sit in every turn.
4. **Level 3 — Proportional delegation & verification:**
   - Work **inline** on small, understood tasks (never spin up a subagent for a 3-line fix).
   - Spawn an **independent verifier** or stricter review **only** on genuinely high-risk changes (data migrations, auth/security boundaries, shared public contracts, concurrency, or areas without automated tests).

---

## Step 4: Deliverable

Produce a concrete **Harness Strip-Down Plan** in the user's language:
1. **Cut now:** Unused MCPs, bloated prompt sections, and subagent/review triggers firing on low-risk edits.
2. **Keep (or make opt-in):** The 1–3 repo rules, skills, or high-risk verification checks that actually prevent expensive mistakes.
3. **Measure before/after:** Pick one representative small bug and one medium feature; compare wall-clock minutes, turns, and token usage before and after trimming layers.
