---
name: hyperframes-shorts
description: "Plan, interview, script, build, and visually verify code-driven short-form videos (TikTok, Instagram Reels, YouTube Shorts, X) using HyperFrames (HTML, CSS, Canvas, GSAP). Use whenever the user asks to create a vertical or short-form video in HyperFrames, replicate an animated coding/dev video without a traditional video editor, build a HyperFrames video with an AI coding agent, set up TikTok/Reels safe zones and word-synced captions, or wants a guided workflow that asks clarifying questions before writing video code."
license: MIT
compatibility: "Requires Node >= 22, HyperFrames CLI, ffmpeg/ffprobe, and Chrome headless (`npx hyperframes browser ensure`). Pair with the official HyperFrames skills (`npx hyperframes skills update`). Works with Claude Code, Codex, Cursor, OpenCode, and Antigravity."
metadata:
  author: Omar Espinosa
  version: "0.1.0"
  repo: https://github.com/OmarAlex24/skills/tree/main/skills/hyperframes-shorts
  install: npx skills add OmarAlex24/skills --skill hyperframes-shorts
  agents: claude-code, codex, cursor, opencode, antigravity
  tags: video, hyperframes, tiktok, reels, shorts, gsap, agents
  description_es: "Crea videos cortos animados (TikTok, Reels, Shorts) con código en HyperFrames. Primero entrevista al usuario en su mismo idioma para despejar dudas sobre tema, formato, estilo, voz y fuentes; luego aplica zonas seguras, ritmo y verificación visual con check y snapshot antes de renderizar."
  summary_es: "Flujo interactivo para producir videos cortos con HyperFrames y tu agente sin renders rotos ni texto tapado."
---

# HyperFrames Shorts

Build code-driven short-form videos (TikTok, Reels, Shorts, X) with [HyperFrames](https://hyperframes.heygen.com) that look intentional, respect mobile safe zones, sync tightly to voiceover, and pass visual verification before you render the final MP4.

Most agent-generated videos fail for the same three reasons: the agent starts coding before clarifying what the user actually wants, guesses layout without platform safe zones, and renders blind without looking at a single frame. This skill fixes all three.

> **Language rule (mandatory):** Always match the language the user is speaking in (for example, reply, interview, draft scripts, and write on-screen copy in Spanish if the user writes in Spanish — unless the user explicitly asks for another language for the video itself). Keep CLI commands and technical identifiers as-is, and **never** default to English just because this `SKILL.md` is written in English.

> **Companion to the official HyperFrames skills.** Install or refresh the official contract first (`npx hyperframes skills update`) so `/hyperframes` is loaded for framework-level rules (`window.__timelines`, `data-start`, deterministic rendering). Never install skills silently — tell the user if `/hyperframes` is missing.

---

## Step 1: Interview the user first (mandatory)

**Do not write `index.html`, generate voiceover, or scaffold animations until you clear up the unknowns.**

Ask the user one compact, easy-to-answer set of questions (use your native question/choice tool if available, or a short numbered list in chat). Keep it brief — 5 to 6 focused questions max:

1. **One core idea & goal:** What is the single thing a viewer should remember after 30–50 seconds? (Tool demo, launch/comparison, engineering story, or quick how-to?)
2. **Platform & format:** Vertical 9:16 (`1080×1920` for TikTok / Reels / Shorts — default) or horizontal 16:9 (`1920×1080` for X / YouTube)?
3. **Visual direction & brand:**
   - Minimal dark editorial with 1 accent color,
   - Dynamic 2.5D/3D perspective panels & procedural Canvas motion, or
   - Your own brand colors/fonts?
   - What `@handle` (if any) should appear on screen?
4. **Voice, language & audio:** Human voice recording, TTS (ElevenLabs / Vercel AI Gateway / other), or no voice (text + music/SFX)? What language and target pace? Want subtle procedural micro-SFX under the voice?
5. **Real captures vs pure code:** Do you have real screen recordings, screenshots, or terminal sessions to show, or should every visual be coded in HTML/CSS/Canvas/GSAP?
6. **Verified facts & CTA:** Are there benchmarks, prices, dates, or CLI commands that must be cited from official sources (zero invented numbers)? What should the ending point to (save, link/repo, next video)?

### Smart defaults (when the user says "decide tú" / "use defaults")

| Decision | Default |
| --- | --- |
| Format | Vertical 9:16 (`1080×1920`, `30 fps`) |
| Duration | `35–48 s` (~115–155 words at ~200 wpm) |
| Visual palette | High-contrast dark background (`#111311`), off-white text (`#ECEDE7`), 1 accent color |
| Typography | Clean geometric sans for UI/titles + monospace strictly for real code/terminal |
| Subtitles | Max 2 lines, word-synced active highlight, dedicated bottom band |
| Audio | Voiceover normalized to `-16 LUFS` + optional deterministic micro-SFX at `-35 LUFS` |

---

## Step 2: Pre-flight check

Before scaffolding, verify the local toolchain (tell the user only what is missing):

- `node -v` (Node 22+)
- `ffmpeg -version` and `ffprobe -version`
- HyperFrames CLI (`npx hyperframes --version`)
- Chrome headless (`npx hyperframes browser ensure`)
- Official `/hyperframes` skill available (`npx hyperframes skills update`)

---

## Step 3: Lock the hook, script, and sources before coding

Present **2–3 hook options** and a **scene-by-scene table** (Voice vs On-Screen Visual) and wait for the user's approval before spending TTS credits or writing animation code.

### Script rules that hold retention

- **One idea per video.** Anything that doesn't serve that idea goes to a future video.
- **Hook under 3 seconds:** `<= 9–10 words` at ~200 wpm. Visible on frame `0` (becomes the cover/thumbnail). No greetings ("Hey guys", "Hola amigos"), no full-screen intro logos, no AI clichés ("Did you know…?", "In the world of…").
- **Voice tells a story; the screen shows the technicals.** Keep CLI commands, flags, file paths, JSON snippets, and URLs **written cleanly on screen** — never make the narrator read `npx ... --flag` aloud.
- **Honest sources:** Every benchmark, price, version, or capability shown must come from an official page, repo, or user-provided measurement. Keep a short `fuentes.md` mapping claims to sources when citing external numbers or third-party benchmarks.

### Word budget reference (~200 wpm)

| Target length | Words (without long pauses) |
| --- | --- |
| ~30 s | 95–105 |
| ~40–45 s | 130–155 |
| ~60 s | 190–205 |

---

## Step 4: Audio-first timing (measure before animating)

If the video has voiceover, **produce or ingest the final audio first** and extract word-level timestamps (e.g., local Parakeet via `npx hyperframes models install parakeet`, or Whisper) before writing timeline cues.

- Normalize voiceover to **`-16 LUFS`** (stereo WAV, `48 kHz`).
- Anchor every scene transition, highlight, terminal reveal, and micro-SFX directly to the real word timestamps — never guess seconds by eye.
- If adding procedural micro-SFX (clicks, whooshes, pops, thumps), synthesize them deterministically (seeded PRNG, no `Math.random()`) pre-attenuated around **`-35 LUFS`** (peaks `<= -18 dBFS`) so they never fight the voice.

---

## Step 5: Layout, safe zones, and HyperFrames contract

### Vertical 9:16 (`1080×1920`) safe zones

TikTok, Reels, and Shorts cover the top bar, bottom caption area, and the right-hand action column. Enforce these hard bounds:

- **Top safe margin:** nothing important above `y = 220`.
- **Bottom safe margin:** nothing important below `y = 1420`.
- **Right action column:** below `y = 840`, keep all important text and UI at `x <= 900`.
- **Dedicated subtitle band:** `x = 180..900`, `y = 1232..1390`, **max 2 lines**, never overlapping terminal/code windows or device frames. Keep all focal panels/devices above `y = 1210`.

### Calm, readable mobile craft

- **One focal visual at a time.** Never stack a terminal behind a phone or throw three windows on screen at once. Transition cleanly between beats.
- **Visible change every ~2 s, never static > 3 s** (outside subtitles) — let real motion inside the visual (typing, chart interpolation, 2.5D camera drift, highlight sweeps) carry the movement instead of frantic cuts.
- **Phone-readable sizing:** at `1080px` canvas width, keep body labels `>= 26–28 px` and code lines `>= 26–32 px`. If you cannot read it at 30% zoom, make it bigger or show fewer lines.

### HyperFrames deterministic rules

1. Register one paused root GSAP timeline on `window.__timelines["<composition-id>"]`. Child timelines added to it must **not** be paused.
2. Every timed scene uses `class="clip"` with `data-start` and `data-duration`. **Never** animate `visibility` or `autoAlpha` on `.clip` elements directly (animate inner containers instead).
3. **100% deterministic & offline-safe:** bundle fonts (`.ttf`/`.woff2`), GSAP, SVGs, and audio locally inside `assets/` — zero remote CDNs, zero `Math.random()`, zero `Date.now()`.
4. Keep visual assets honest: use official brand SVGs unmodified when referencing a tool/lab, and never fabricate terminal output or fake benchmark charts.

---

## Step 6: Self-verify visually (never render blind)

Run this exact loop before presenting a video to the user:

```bash
# 1. Automated contract check (lint, runtime, layout, motion, contrast)
npx hyperframes check

# 2. Render key PNG frames across every scene and transition
npx hyperframes snapshot --at 0,2.5,6,12,18,24,30,38,44
```

1. **Fix every error** reported by `hyperframes check` (aim for `0` errors in Lint, Runtime, Layout, Motion, and Contrast).
2. **Open and visually inspect every snapshot PNG.** Check for:
   - Text clipped, wrapped awkwardly, or colliding with subtitles.
   - Anything leaking outside safe zones (`y < 220`, `y > 1420`, or `x > 900` below `y = 840`).
   - Low-contrast code or unreadable small labels at mobile scale.
   - Blank frames between scene crossfades.
3. **Iterate until clean**, then render a fast draft for the user to review:
   ```bash
   npx hyperframes render --output salida/borrador.mp4 --video-frame-format png --quality draft
   ```
4. Once the user approves the draft, render the final master:
   ```bash
   npx hyperframes render --output salida/final.mp4 --video-frame-format png --quality high
   ```

---

## Checklist before finishing

- [ ] User questions answered (or defaults confirmed) before writing code.
- [ ] Hook is visible on frame 0 and finishes speaking before `3.0 s`.
- [ ] Zero CLI commands or URLs read aloud awkwardly in voiceover (all written on screen).
- [ ] All claims, metrics, and prices verified against sources.
- [ ] `npx hyperframes check` passes with `0` errors.
- [ ] Key `snapshot` PNGs visually inspected at mobile readability.
- [ ] Draft MP4 reviewed before `--quality high` final render.
