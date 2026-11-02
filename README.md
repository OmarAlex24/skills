# skills

Agent skills by [Omar Espinosa](https://www.omaralex.dev/skills/). Each one is a folder under `skills/` with a `SKILL.md`, so any agent that reads skills (Claude Code, Codex, Cursor, opencode, ...) can use it.

| Skill | What it does |
| --- | --- |
| [boated-ci](skills/boated-ci) | Turns a GitHub Actions CI with one VM per job into one heavy job per PR run, for runner providers that bill or cap per machine start (Boat and similar). |

## Install

```bash
npx skills add OmarAlex24/skills --skill boated-ci
```

Or copy the folder by hand, for example into `~/.claude/skills/`.

## License

MIT, see [LICENSE](LICENSE).
