# Consolidation patterns

How to turn N parallel jobs into one heavy job without losing speed or
clarity. `templates/heavy-job.yml` shows all of these together.

## Contents
1. Before / after
2. Router as a step
3. Background tasks: start and wait
4. Foreground trunk and `!cancelled()`
5. No aggregate job; one required check
6. Concurrency groups under per-start billing
7. Runner by variable
8. Ordering and priorities
9. Memory guard
10. Shared resources
11. What NOT to fold in

## 1. Before / after

Before (one VM per job, ~4-9 starts per PR run):

```yaml
jobs:
  detect-changes: { runs-on: small, outputs: {...} }          # 40 s of work, 1 start
  lint-typecheck: { needs: detect-changes, runs-on: large }
  e2e:            { needs: detect-changes, if: web, runs-on: large }
  go:             { needs: detect-changes, if: go,  runs-on: small }
  images:         { needs: detect-changes, strategy: { matrix: { image: [a, b, c] } } }  # 3 starts
  ci:             { needs: [lint-typecheck, e2e, go, images], if: always() }            # aggregate, 1 start
```

After (1 start per PR run; 2 on main with deploy):

```yaml
jobs:
  quality:                # the only required check
    runs-on: ${{ fromJSON(vars.CI_RUNS_ON_QUALITY || '["boat-xlarge"]') }}
    steps:
      - checkout, sampler
      - route   -> $GITHUB_ENV flags
      - plan    -> steps.skip.outputs.*
      - start images (bg), start go-tests (bg)
      - install
      - start e2e (bg), start coverage (bg)
      - lint, typecheck, build, unit tests (fg)
      - wait coverage / e2e / go-tests / images
      - metrics, upload logs, publish per-task checks
  deploy: { needs: quality, if: push to main }
```

The heavy job is not slower in wall time if the machine is big enough: the
tasks still run in parallel, they just share one machine, one checkout, one
install and one cache restore. Installing once is often a large win by itself
(one real case: install paid twice per run, median 60 s, p90 130 s).

## 2. Router as a step

A change-detection job is the worst start in the CI: a whole machine for
seconds of work, plus queue latency before every other job. Make it the first
step of the heavy job and export flags:

```bash
echo "E2E_CHECKS=true" >> "$GITHUB_ENV"
```

`$GITHUB_ENV` reaches every later step AND every background task, because
`ci-task.ts start` launches the script with the step's environment.

Keep the router **fail closed**: unknown paths, toolchain files, `.github/`
changes, non-PR events, or any diff error => everything true. If it has tests,
run them as the step before it (cheap, and a broken router is the worst bug a
CI can have: it silently runs nothing).

If downstream jobs (deploy) need router outputs, also write them to
`$GITHUB_OUTPUT` with an `id:` and expose them as job `outputs:`.

A docs-only PR still costs 1 start (the heavy job starts, routes, and ends
green quickly). That is the price of having one required check. If docs-only
PRs are a big share, a workflow-level `paths-ignore` avoids the start, but
then the required check never reports: use it only if your branch protection
tolerates that (e.g. via a rule set that does not require the check for those
paths).

## 3. Background tasks: start and wait

```yaml
- name: "e2e: start in the background"
  if: steps.install.outcome == 'success' && env.E2E_CHECKS == 'true' && steps.skip.outputs.e2e != 'true'
  run: |
    bun "$CI_SCRIPTS/ci-task.ts" start e2e <<'EOF'
    set -euo pipefail
    cd "$GITHUB_WORKSPACE"
    bun run test:e2e
    EOF
# ... trunk ...
- name: "e2e: result"
  if: ${{ !cancelled() && steps.install.outcome == 'success' && env.E2E_CHECKS == 'true' && steps.skip.outputs.e2e != 'true' }}
  run: bun "$CI_SCRIPTS/ci-task.ts" wait e2e 1500
```

Rules that bite:
- **Quote the heredoc** (`<<'EOF'`): expand variables when the task runs, not
  in the start step's shell.
- The task inherits the start step's `env:`. Variables computed in the start
  step's shell must be `export`ed before `start`.
- `GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_PATH` written by a background task go
  nowhere (the step that owned them has ended). Compute outputs in the
  foreground. `GITHUB_STEP_SUMMARY` works: `wait` appends it.
- `uses:` actions cannot run in the background. Keep them before the start
  step, gated by the same flags.
- `wait <seconds>` counts from the task's start, not from the wait step. Give
  it more than the task's p90 plus whatever it may wait for.
- The wait step's condition must mirror the start step's. A wait for a task
  that never started reports "did not start" and fails, which is what you want
  when the start step crashed, and what you do not want when it was skipped on
  purpose.

## 4. Foreground trunk and `!cancelled()`

Default step semantics stop at the first failure. With one job per check that
was fine; inside one heavy job it hides every later check, and a rerun costs a
start. Use `if: ${{ !cancelled() && steps.install.outcome == 'success' && ... }}`
so lint, typecheck, build and tests all report in one run. Steps that truly
depend on another step's output check its `outcome` (`steps.build.outcome == 'success'`).

## 5. No aggregate job; one required check

The classic `ci: needs: [all], if: always()` job exists to give branch
protection one name. With one heavy job, the heavy job IS that name. Delete the
aggregate (it was a whole start per run) and require only `quality`. The
per-task checks are informative; do not make them required (a task skipped on
rerun or routed out publishes nothing new).

Remember to update branch protection when removing/renaming jobs, or PRs wait
forever for a check that will never come.

## 6. Concurrency groups under per-start billing

`cancel-in-progress: true` was designed for per-minute billing: cancelling
stops paying. Under per-start billing the cancelled job already paid its start,
and on a busy main branch it can be most runs (one real day: 31 of 52 push runs
on main ended cancelled; 55 quality jobs started and were then cancelled).

```yaml
concurrency:
  group: ${{ github.event_name == 'push' && 'ci-main' || format('ci-{0}', github.event.pull_request.number || github.run_id) }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

On main: one run in progress, at most one pending; a newer push replaces the
pending run before it starts any job (0 starts). The next run tests a tree that
includes every replaced commit. If your router diffs against "the previous
push", diff against the last green run on main instead, or replaced commits'
changes go untested.

PRs still cancel: the old run's start is lost anyway, and its remaining minutes
are saved.

Remove job-level concurrency groups with cancel-in-progress from test jobs.
Keep `cancel-in-progress: false` groups for deploys.

## 7. Runner by variable

```yaml
runs-on: ${{ fromJSON(vars.CI_RUNS_ON_QUALITY || vars.CI_RUNS_ON_HEAVY || '["boat-large"]') }}
```

Switching size or provider during an incident becomes
`gh variable set CI_RUNS_ON_QUALITY --body '["ubuntu-latest"]'`, no PR, no
review. Use a chain of fallbacks so deleting the specific variable falls back
to a sane class.

## 8. Ordering and priorities

The job lasts as long as `max(task end) + collection`. So:
- Start each task as soon as its inputs exist: tasks that need no install
  (images, Go, Python) start before `install`; tasks that need it start right
  after.
- Start the longest task first. If one task is always last, find what it
  really needs (one real case: coverage needed only install + one binary, not
  typecheck/build; starting it right after install cut ~70 s).
- `renice -n 10..19` tasks with slack (e2e, images) so the trunk on the
  critical path wins CPU. Measure: raising priority of a task did not help in
  one experiment; lowering slack tasks did.
- Bounded inner concurrency: if tests are already parallel inside a task, a
  higher worker count on a full machine causes timing flakes, not speed (real
  case: web test concurrency 8 failed 3 of 5 runs, 6 failed 0 of 5 and was not
  slower).

## 9. Memory guard

Overlapping tasks stack memory peaks. On a big runner it is fine; when the job
falls back to a smaller class (variable deleted, incident), the same overlap
OOM-kills (exit 137). `wait-for-marker.sh` lets a task wait for a marker file
(written by the heavy foreground step from a `trap ... EXIT`) only when
`MemTotal` is under a threshold:

```bash
bash "$CI_SCRIPTS/wait-for-marker.sh" coverage "$RUNNER_TEMP/typecheck.done"   # WAIT_MIN_MEMORY_GB=24
```

Add swap on small machines as a last resort; it trades OOM for slowness.

## 10. Shared resources

Prep steps that serve several tasks (start Postgres, set up Go, pull images)
are declared as `uses` in `.github/ci-tasks.json`. `plan` outputs
`steps.skip.outputs.<resource> == 'true'` only when every enabled task using it
was skipped. Isolate names per run (`pg-${{ github.run_id }}-${{ github.run_attempt }}`)
if the runner may be reused, and tear down with `if: always()`.

## 11. What NOT to fold in

- **Deploys**: different permissions, different concurrency (never cancel),
  should not run with PR code's token. Keep as its own job (`needs: quality`).
- **Work that needs a different OS/arch** (macOS, Windows, arm64).
- **Secrets the PR job must not see**: everything in one job shares one token
  and one environment. If folding in a job means granting `packages: write` or
  `id-token: write` to the job that runs PR code, consider whether that is
  acceptable; GitHub permissions are per job, not per event or step.
- **Nightly/long suites**: keep them in a scheduled job; they do not affect PR
  starts.
- Work that would make the heavy job exceed its timeout or the largest machine.
