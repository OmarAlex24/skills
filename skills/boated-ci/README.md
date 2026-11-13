# boated-ci

A [Claude Code](https://claude.com/claude-code) skill that turns a "normal"
GitHub Actions CI (many parallel jobs, one VM per job) into a **boated CI**:
one heavy job per pull request run that does the work of many jobs as parallel
background tasks, while keeping a clear result per task and cheap reruns.

It is built for runner providers that bill or cap **per machine start**
(Boat / boat.dev was the motivating case: plans cap starts per minute, hour and
day). Every GitHub job that gets a runner costs a start, so the number of jobs,
not their minutes, is the bill.

From a real migration of a production TypeScript/Go monorepo: ~3.9 starts per
run and a 964-starts day (over an 840/day cap) became **1 start per PR run**,
~32 % of the cap on the heaviest day, with the heavy job at ~380 s.

Not on Boat yet? Its companion skill
[boat-ci](https://omaralex.dev/skills/boat-ci/) moves the jobs there first
(`runs-on: boat` or the CLI from any CI); this one takes over when starts
become the limit.

## What the skill gives the agent

- **A decision tree**: does your CI need this at all (audit first), should you
  consolidate, or do you need box reuse?
- **A step-by-step playbook**: audit, plan, consolidate, per-task checks,
  skip-on-rerun, measure, size, tune, with a verification checklist,
  pitfalls and rollback.
- **Scripts** (Bun + TypeScript, no npm dependencies, tested):
  - `audit-starts.ts`: starts per day / peak hour / peak minute, per job,
    label and event, from the GitHub API; verdict against a plan.
  - `ci-task.ts`: `start` / `wait` background tasks inside one job, `publish`
    one check run `<job> / <task>` per task with the trimmed failure and
    annotations, `plan` to skip tasks already green on the same merge commit,
    `mask` secrets in task logs.
  - Failure extractors for bun test, go test, Playwright, TAP/pgTAP,
    tsc/eslint/oxlint/golangci-lint style `file:line:col`, and a de-noised tail.
  - `machine-sampler.sh` + `task-metrics.ts`: whole-machine CPU, **steal** and
    memory per task window.
  - `wait-for-marker.sh`: memory guard for smaller fallback runners.
- **Templates**: a commented end-to-end workflow (`templates/heavy-job.yml`,
  actionlint-clean) and a task manifest.
- **References**: auditing, consolidation patterns, per-task checks,
  skip-on-rerun security, measurement protocol, sizing and cost, box-reuse
  routers, and the anonymised case study.

## Install

```bash
# any agent that reads skills (Claude Code, Codex, Cursor, opencode, ...)
npx skills add OmarAlex24/skills --skill boated-ci

# or by hand, into Claude Code
git clone https://github.com/OmarAlex24/skills
cp -r skills/skills/boated-ci ~/.claude/skills/
```

Claude Code lists it among the available skills on the next session; or just ask
about your CI. Optional: run the script tests with
`cd ~/.claude/skills/boated-ci/scripts && bun test`.

## Usage examples

Ask Claude Code things like:

- "We moved our runners to Boat and hit the 840 starts/day cap yesterday.
  Audit `.github/workflows` and plan how to boat-ify our CI."
- "Our PR CI runs 7 jobs. Merge them into one job without making it slower,
  and keep a separate check per suite."
- "Reruns re-run the whole heavy job. Make `gh run rerun --failed` skip the
  suites that already passed."
- "Is it worth moving the quality job from 8 to 16 vCPU? Add measurements."

Or run the audit yourself:

```bash
bun ~/.claude/skills/boated-ci/scripts/audit-starts.ts --repo owner/name --days 7 --plan 100
```

## Requirements

- Bun >= 1.1 (scripts), `gh` CLI authenticated (audit), Linux runners with
  `/proc` (machine sampling; it degrades to a warning elsewhere).
- Pricing and plan limits in the references were collected around 2026-11-01.
  Verify current pricing with your provider.

## Credits

- Box-reuse router ideas (reuse boxes after a light reset, shared start
  ledger with pacing, local machines first, idle hold) come from the article by
  @jackson_felty and the repository
  [pnkfluffy/boat-router](https://github.com/pnkfluffy/boat-router).
- Built from a real CI migration; all project-specific names were removed.

## License

MIT, see [LICENSE](LICENSE).
