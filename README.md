# skills

Agent skills by [Omar Espinosa](https://www.omaralex.dev/skills/). Each one is a folder under `skills/` with a `SKILL.md`, so any agent that reads skills (Claude Code, Codex, Cursor, opencode, ...) can use it.

| Skill | What it does |
| --- | --- |
| [audit-agent-harness](skills/audit-agent-harness) | Audits extra frameworks, prompt layers, MCPs, skills, and subagent routing stacked on top of a coding agent using real latency/token tradeoffs and verified `gentle-ai` benchmarks. |
| [boat-ci](skills/boat-ci) | Moves CI jobs from hosted runners to boat.dev sandboxes (`runs-on: boat` or the CLI from any CI), with cost limits and a rollback path. |
| [boated-ci](skills/boated-ci) | Turns a GitHub Actions CI with one VM per job into one heavy job per PR run, for runner providers that bill or cap per machine start (Boat and similar). |
| [choose-ade](skills/choose-ade) | Chooses or streamlines an Agentic Development Environment (T3 Code, Orca, Herdr, Zeron, or Bare CLI) using verified ADEMark tradeoffs and a less-is-more workflow diagnostic. |
| [choose-deploy-platform](skills/choose-deploy-platform) | Audits a repo to choose honestly between managed PaaS (Cloudflare, Netlify, Railway, Render, Fly.io, Cloud Run) and self-hosted VPS panels (Dokploy, Coolify), plus a Day-2 ops checklist. |
| [compare-ai-subscriptions](skills/compare-ai-subscriptions) | Compares AI coding subscriptions (Claude, Google AI, ChatGPT/Codex, Cursor, Devin, OpenCode Go vs. direct API) by real API-priced value per dollar using verified Priors subsidy data. |
| [context-cache-hygiene](skills/context-cache-hygiene) | Optimizes prompt-cache hits and `/compact` timing in coding agent sessions (warm cache vs stepping away), plus an instruction/MCP prefix audit. |
| [hyperframes-shorts](skills/hyperframes-shorts) | Interviews you, then plans, builds and visually checks code-driven short videos (TikTok, Reels, Shorts) with HyperFrames: safe zones, word-synced captions, check and snapshot before rendering. |
| [llm-memory-sizing](skills/llm-memory-sizing) | Calculates LLM weights, KV Cache, and memory-bandwidth speed ceilings (`tok/s`) across DDR5, unified memory, GDDR7, and HBM before buying hardware or renting GPUs. |

## Install

```bash
npx skills add OmarAlex24/skills --skill audit-agent-harness
npx skills add OmarAlex24/skills --skill boat-ci
npx skills add OmarAlex24/skills --skill boated-ci
npx skills add OmarAlex24/skills --skill choose-ade
npx skills add OmarAlex24/skills --skill choose-deploy-platform
npx skills add OmarAlex24/skills --skill compare-ai-subscriptions
npx skills add OmarAlex24/skills --skill context-cache-hygiene
npx skills add OmarAlex24/skills --skill hyperframes-shorts
npx skills add OmarAlex24/skills --skill llm-memory-sizing
```

Or copy the folder by hand, for example into `~/.claude/skills/`.

## License

MIT, see [LICENSE](LICENSE).
