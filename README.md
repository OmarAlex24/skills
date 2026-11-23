# skills

Agent skills by [Omar Espinosa](https://www.omaralex.dev/skills/). Each one is a folder under `skills/` with a `SKILL.md`, so any agent that reads skills (Claude Code, Codex, Cursor, opencode, ...) can use it.

| Skill | What it does |
| --- | --- |
| [boat-ci](skills/boat-ci) | Moves CI jobs from hosted runners to boat.dev sandboxes (`runs-on: boat` or the CLI from any CI), with cost limits and a rollback path. |
| [boated-ci](skills/boated-ci) | Turns a GitHub Actions CI with one VM per job into one heavy job per PR run, for runner providers that bill or cap per machine start (Boat and similar). |
| [hyperframes-shorts](skills/hyperframes-shorts) | Interviews you, then plans, builds and visually checks code-driven short videos (TikTok, Reels, Shorts) with HyperFrames: safe zones, word-synced captions, check and snapshot before rendering. |

## Install

```bash
npx skills add OmarAlex24/skills --skill boat-ci
npx skills add OmarAlex24/skills --skill boated-ci
npx skills add OmarAlex24/skills --skill hyperframes-shorts
```

Or copy the folder by hand, for example into `~/.claude/skills/`.

## License

MIT, see [LICENSE](LICENSE).
