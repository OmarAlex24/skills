---
name: context-cache-hygiene
description: "Optimize prompt-cache hits and /compact timing in AI coding sessions (Claude Code, Codex, Gemini, Cursor, OpenCode). Use whenever the user asks when to run /compact, how to cut token costs in long agent sessions, why prompt caching is missing or breaking, how to audit CLAUDE.md / AGENTS.md / MCP tool overhead, or wants a practical caching and session-hygiene plan."
license: MIT
compatibility: "Works with any coding agent or CLI that supports prompt caching and session compaction (Claude Code, Codex, Cursor, OpenCode, Antigravity)."
metadata:
  author: Omar Espinosa
  version: "0.1.0"
  repo: https://github.com/OmarAlex24/skills/tree/main/skills/context-cache-hygiene
  install: npx skills add OmarAlex24/skills --skill context-cache-hygiene
  agents: claude-code, codex, cursor, opencode, antigravity
  tags: context, caching, tokens, compact, agents, cost
  date: "2026-11-24"
  video: "014-deja-de-compactar"
  description_es: "Optimiza el caché de prompts y decide exactamente cuándo usar /compact en tus sesiones con agentes. Aplica la regla práctica: caché caliente no se compacta; compacta antes de irte o cuando el ruido real degrada respuestas, más una auditoría rápida de archivos de instrucciones y MCPs."
  summary_es: "Reglas y auditoría práctica para aprovechar caché caliente (90–95 % más barato) y compactar en el momento correcto."
---

# Context & Cache Hygiene

Keep your prompt cache warm during active coding sessions and run `/compact` only when it actually saves money or restores quality.

Many developers run `/compact` every few turns out of habit from older models that degraded sharply past ~200k tokens. With modern long-context models and prefix-based prompt caching, compacting mid-flow often **increases** cost instead of reducing it.

> **Language rule (mandatory):** Always match the language the user is speaking in (for example, reply and write checklists in Spanish if the user writes in Spanish). Keep CLI commands, file names, and technical terms as-is.

---

## Core Economics (Why Timing Matters)

Prompt caching matches an **exact token prefix** from the start of the conversation:

| Operation | Relative cost | What happens |
| --- | --- | --- |
| **Cache read (warm)** | **0.05× – 0.10×** (90–95% cheaper) | Re-reads cached history cheaply while the session is active (e.g. Gemini 4 Neon: `$3.00 -> $0.15 / 1M`; Anthropic recent models: `0.1×` to `0.05×`). |
| **Summary generation (`/compact`)** | **~5×** (output tokens) | Summarizing the thread burns expensive output tokens (e.g. `$15` vs `$3` input on Neon). |
| **Cache rewrite (post-compact)** | **1.25× – 2.0×** | Compacting breaks the cached prefix, so the very next turn pays cache-write rates to rebuild it. |
| **Cache TTL** | **5 min – 1 h** | Once you step away longer than the provider's TTL, the cache goes cold anyway. |

**The Golden Rule:**
- **Cache is warm (working actively):** Do **not** `/compact` out of panic. Let the cache read at 90–95% off.
- **Stepping away (lunch, meeting, end of day):** **Do** `/compact` right before leaving while the cache is still warm. When you return after TTL expiry, you only pay to re-cache the compact summary instead of the entire raw transcript.
- **Exception (real context rot):** Modern models hold up much better at long context than older generations, **but noise still degrades quality**. Compact or start a fresh thread when the session is polluted with dead-end debugging, unrelated tasks, or huge stale logs.

---

## Step 1: Quick Diagnostic (Ask or Inspect)

When invoked, identify which mode the user needs:

1. **Session decision ("Should I compact or start fresh right now?"):**
   - Are you continuing immediately (warm cache) or stepping away (`> 5–60 min`)?
   - Is the thread still on the same task, or full of dead ends / unrelated tasks / huge raw dumps?
   - Roughly how full is the context window and are you seeing repetition, missed constraints, or drift?
2. **Repo & Agent Prefix Audit ("Audit why my sessions cost too much / break cache"):**
   - Inspect instruction files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.claude/`), configured MCP servers, and loaded skills if present in the workspace.

---

## Step 2: Apply the Decision Matrix

| Situation | Action | Why |
| --- | --- | --- |
| Active flow, same task, `< 60–70%` context, answers still sharp | **Keep going — do NOT `/compact`** | Cache reads are 90–95% cheaper than breaking the prefix and rewriting. |
| Stepping away for `> 5 min` (API) or `> 1 h` (extended TTL) and plan to resume this task | **Run `/compact` right before leaving** | Uses the warm cache one last time to shrink history so returning with a cold cache is cheap. |
| Switching to an unrelated feature or bug | **Start a new thread** | Clean prefix, zero cross-task noise, no summary output cost. |
| Same task, huge noisy debug loop / repeated mistakes / near context limit | **Run `/compact` with a focused focus-note** (or hand off to a fresh thread with a 10-line summary) | Restores signal-to-noise; quality beats micro-optimizing cache. |

---

## Step 3: Repo & Prompt-Prefix Audit (When Inspecting a Project)

If the user asks to audit their workspace or agent setup, check for these exact cache-killers:

1. **Bloated always-loaded instructions:**
   - Measure `CLAUDE.md` / `AGENTS.md` size (`wc -l`, `wc -c`). Flag anything bloated with prose, stale plans, or task-specific runbooks that should live in on-demand docs or skills.
2. **Tool / MCP schema bloat:**
   - Count active MCP servers and tools injected into every turn. Unused MCP tool definitions sit in the prefix and burn tokens on every cold start and cache write.
3. **Prefix instability (for custom LLM apps / API callers):**
   - Check whether dynamic values (current timestamps with seconds, random UUIDs, per-turn reordered tool lists, user-specific volatile state) are injected **above** static system prompts or few-shot examples.
   - Fix order: **Static system prompt → Tool definitions → Stable repo/doc context → Volatile per-turn state → Conversation turns.**
4. **Noisy tool outputs:**
   - Check whether tests/builds dump thousands of verbose lines into agent context instead of concise failures (`--reporter=dot`, tailing failures, targeted test runs).

---

## Step 4: Deliverable

Return a crisp, scannable report in the user's language:
1. **Immediate call:** `Keep warm` / `Compact before stepping away` / `Start fresh thread` — with 1-line reason.
2. **Audit findings (if workspace inspected):** exact file paths, line counts, and top 3 changes ranked by token savings.
3. **Copy-paste habit card:** the 3-line personal rule tailored to their tool/provider TTL.
