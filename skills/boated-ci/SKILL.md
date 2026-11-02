---
name: boated-ci
description: Convert a GitHub Actions CI with many parallel jobs (one VM per job) into a 'boated' CI for runner providers that bill or cap per machine start (Boat / boat.dev and other per-start plans with sandbox starts per day, hour and minute). It audits starts, consolidates jobs into one heavy job with parallel background tasks, publishes one check per task with a trimmed failure, skips already-green tasks on reruns, and measures CPU, steal and memory to pick the machine size. Use this whenever the user mentions Boat runners, boat-ify or boated CI, machine starts or a starts-per-day/hour/minute cap, hitting a runner quota, too many CI jobs or VMs per run, merging or consolidating CI jobs, removing a detect-changes or aggregate job, background steps inside one job, per-task check runs, rerunning only failed tasks, or cancel-in-progress wasting paid starts, even if they never say boated.
license: MIT
compatibility: "Scripts need Bun >= 1.1 and an authenticated gh CLI; machine sampling needs Linux runners with /proc. Works with any GitHub Actions runner provider."
metadata:
  author: Omar Espinosa
  version: "0.1.0"
  repo: https://github.com/OmarAlex24/skills/tree/main/skills/boated-ci
  install: npx skills add OmarAlex24/skills --skill boated-ci
  agents: claude-code, codex, cursor, opencode
  tags: ci, boat, github-actions, cost
  description_es: "Convierte un CI de GitHub Actions con muchos jobs en paralelo (una VM por job) en un CI 'boated' para proveedores que cobran o limitan por arranque de máquina, como Boat: un job pesado con tareas en paralelo, un check por tarea, reruns que se saltan lo que ya pasó y mediciones para elegir el tamaño de la máquina."
  summary_es: Pasa de una VM por job a un arranque por PR sin perder velocidad, claridad ni reruns baratos.
---

# Boated CI

A **boated CI** starts as few machines as possible: one heavy job per pull
request run that does the work of many jobs as parallel background tasks, and
still gives a clear result per task and cheap reruns. It exists because some
runner providers bill or cap **per machine start** instead of per minute:
every GitHub job that gets a runner costs one start, a job skipped by `if:`
costs nothing, and a job cancelled after it got a machine already paid.

Under per-minute billing, many small parallel jobs are nearly free. Under
per-start billing they are the bill. The goal changes from "minimise minutes"
to "minimise starts without losing speed, clarity or safety".

Everything below is generic GitHub Actions; Boat is the motivating case.

## Bundled resources

| Path | Use it for |
| --- | --- |
| `scripts/audit-starts.ts` | Measure starts/day, peak hour, peak minute, per job/label/event, verdict vs a plan. Run first. |
| `scripts/ci-task.ts` (+ `ci-task-*.ts`) | Engine: `start`/`wait` background tasks, `plan` skip-on-rerun, `publish` per-task checks, `mask` secrets. Copy into the target repo. |
| `scripts/machine-sampler.sh`, `step-window.sh`, `task-metrics.ts` | Whole-machine CPU/steal/memory sampled every 2 s and sliced per task. |
| `scripts/wait-for-marker.sh` | Memory guard so overlapping peaks do not OOM a smaller runner. |
| `templates/heavy-job.yml`, `templates/ci-tasks.json` | End-to-end example workflow and task manifest. Start from these. |
| `references/*.md` | Details; each step below says which one to read. |

The scripts need only Bun (no npm dependencies). Tests: `cd scripts && bun test`.

## The start budget

```
starts/day ≈ runs/day × starts per run + rerun starts + scheduled runs
```

Check all three caps on the **heaviest** day, not the average: day, peak hour,
peak minute. Fan-out (matrix, many jobs per run, several PRs at once) breaks
the minute cap long before the day cap. Aim for ≤ ~50 % of each cap so a
release day, a dependency-bot wave or a rerun storm still fits.

Example: 250 runs/day × 3.9 starts/run ≈ 975 starts > 840 cap. At 1 start per
PR run and 2 per main run the same day is ~270 (32 %).

## Decision tree

1. **Audit** (`audit-starts.ts`). Peak usage ≤ ~50 % of every cap →
   **stop**: do not restructure; only fix waste (full reruns,
   cancelled-after-start on main). Restructuring has real costs.
2. Over ~50 %, or over a cap, and starts per run > ~1.3 →
   **consolidate** (this playbook).
3. Still over the cap at ~1 start per run (`jobs/day ÷ starts included > 1`) →
   **box reuse** with a router/pool, or a bigger plan. Read
   `references/box-reuse-router.md`. Target jobs per box ≥ that ratio.

## Playbook

Work in this order. Each step is a separate, reviewable PR; measure between them.

### 1. Audit
`bun scripts/audit-starts.ts --repo owner/name --days 7 --plan 100`
(`--cap-*` for other providers). Note starts per run per event, short jobs
(< 3 min), cancelled-after-start, rerun starts. → `references/audit.md`.

### 2. Plan
Write a table: each current job → (a) stays a job, (b) becomes a foreground
step, (c) becomes a background task, (d) deleted. Usually:
- router/detect-changes → first step; aggregate "all green" job → deleted;
- lint/typecheck/build/unit tests → foreground trunk;
- slow independent suites (e2e, DB, Go, Python, image builds, coverage,
  benchmarks) → background tasks;
- deploys, other OS/arch, jobs needing secrets PR code must not see → stay jobs.

Project: starts per run after = 1 (+ jobs that stay). Recompute the budget.
Decide the required check (the heavy job's name) and the machine size (start
one size up from the largest job you are merging; tune in step 7).

### 3. Consolidate
Start from `templates/heavy-job.yml`. Copy `scripts/` to `.github/boated-ci/`
(or wherever `CI_SCRIPTS` points). Key moves → `references/consolidation-patterns.md`:
- router step writes flags to `$GITHUB_ENV` (fail closed);
- `ci-task.ts start <task> <<'EOF'` for each background task, as early as its
  inputs allow, longest first; `renice` tasks with slack;
- foreground steps use `if: ${{ !cancelled() && ... }}` so one failure does not
  hide the rest (a rerun costs a start);
- `ci-task.ts wait <task> <seconds>` per task, same condition as its start
  plus `!cancelled()`;
- `runs-on: ${{ fromJSON(vars.CI_RUNS_ON_X || '["default"]') }}`;
- workflow concurrency: cancel in progress on PRs only; never cancel started
  runs on main;
- delete the aggregate job; update branch protection to require the heavy job.

### 4. Per-task checks
Upload `$RUNNER_TEMP/background-steps/*.log` as an artifact, then
`ci-task.ts publish` with `checks: write`. One check `<job> / <task>` per task
with the trimmed failure and annotations. Logs are masked before storage
(background output bypasses the runner's masking). → `references/per-task-checks.md`.
Tell agents in AGENTS.md/CLAUDE.md to read `gh api repos/O/R/check-runs/<id> --jq .output.text`
before the job log.

### 5. Skip-on-rerun
Add `.github/ci-tasks.json` (tasks, `enabledBy` flag, shared `uses`), the
`plan` step (`id: skip`, PR only, `continue-on-error`), and
`steps.skip.outputs.<task> != 'true'` on each task's start, wait and exclusive
prep steps. Move any gate that can fail into its task. → `references/rerun-skip.md`.

### 6. Measure
`machine-sampler.sh` early, `step-window.sh` around long foreground steps,
`task-metrics.ts` at the end, samples uploaded. → `references/measurement.md`.

### 7. Size and tune
Read the metrics table: CPU pinned → size up; one task always last → start it
earlier or split it; memory near the top → memory guard or size up. Run
experiments sequentially, ≥ 5 runs per variant, discard steal > ~8 %, compare
time after install. → `references/measurement.md`, `references/sizing-and-cost.md`.

## Verification checklist

Before calling the migration done, confirm with real runs, not just YAML:
- [ ] `actionlint` clean; `bun test` in the copied scripts passes.
- [ ] A PR run starts exactly the expected number of machines (re-run
      `audit-starts.ts` on that window, or check the run's jobs: only the heavy
      job has a runner).
- [ ] A docs-only PR ends green after the router with nothing heavy running.
- [ ] A deliberately failing task: heavy job red, `quality / <task>` red with
      the right excerpt and annotations, other tasks green, log artifact present
      and masked (grep it for a known secret value).
- [ ] `gh run rerun <id> --failed` on that PR: green tasks skipped (plan summary
      lists them), failed task runs, shared prep skipped only when all users skipped.
- [ ] A push to main: nothing skipped, deploy (if any) waits for the heavy job.
- [ ] Two quick pushes to main: the second run waits; the first is not cancelled.
- [ ] Branch protection requires the heavy job, not deleted job names.
- [ ] The metrics table appears in the job summary with a steal column.
- [ ] Projected and measured starts/day ≤ ~50 % of the plan on a busy day.

## Pitfalls

- Counting check runs as starts: the jobs API lists API-created checks as
  pseudo-jobs without labels or runner. Count only jobs with a runner.
- Background tasks writing `GITHUB_OUTPUT`/`GITHUB_ENV`: lost. Compute outputs
  in the foreground; export variables before `start`.
- Unquoted heredoc (`<<EOF`): variables expand in the start step, not the task.
- A gate as its own step after a skippable task: silently skipped on rerun.
- `cancel-in-progress: true` on main under per-start billing: pays starts for
  nothing; queue instead.
- Overlapping memory peaks on a fallback smaller runner: exit 137. Use the
  memory guard and keep the size in a variable.
- Raising inner test concurrency on a full machine: timing flakes, not speed.
- Comparing runs with high steal or a slow-booting VM: false conclusions.
- One job means one token: folding a job that needs `packages: write` or
  `id-token: write` grants it to everything that runs PR code in that job.
- Full reruns (`gh run rerun <id>` / "Re-run all jobs"): every job pays again.

## Rollback

Keep it cheap to undo:
- The runner class is a repository variable: switch provider/size without a PR.
- `CI_TASK_SKIP_PASSED=false` disables skip-on-rerun instantly.
- Per-task publishing and metrics are `continue-on-error`: they never turn the
  job red; delete the steps to remove them.
- Consolidation itself: revert the workflow PR and restore the old required
  checks in branch protection (do this in the same change, or PRs block).
- For a staged migration, consolidate one job at a time and keep the old job
  behind `if: vars.LEGACY_<JOB> == 'true'`.

## Further reading

- `references/case-study.md`: full numbers from a real migration (964 starts/day
  and 42/min down to ~1 start per PR run).
- Credits: box-reuse ideas from the article by @jackson_felty and
  `github.com/pnkfluffy/boat-router`.
