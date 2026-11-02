# Skip-on-rerun

With N jobs, `gh run rerun <id> --failed` re-ran only the failed job. With one
heavy job, the failed job IS everything: the rerun repeats every task. Skip-on-
rerun gives back the old behaviour: on a PR rerun, background tasks whose
check is already green **for the same code** do not run again; only the failed
ones and the foreground trunk do.

## The decision (`ci-task.ts plan`, ci-task-skip.ts)

For each task in the manifest, fetch
`GET /repos/{o}/{r}/commits/{HEAD_SHA}/check-runs?check_name=<job> / <task>&app_id=15368&filter=all`
and skip the task only if some check run has all of:

1. `app.id == 15368` (GitHub Actions, the app the job token publishes as),
2. `external_id == "<task>@<github.sha>"` exactly (the PR test-merge commit),
3. `conclusion == "success"`.

Why each condition:
- **Exact merge SHA**: a rerun keeps `github.sha`; a new push, or the base
  branch moving and GitHub recomputing the merge, gives a new merge commit, a
  new key, and everything runs. Keying by the PR head SHA alone would skip
  tasks after main changed under them.
- **App id**: anyone with `checks: write` through another app could create a
  check with the right name and key. Only the workflow's own token is trusted.
- **Fork PRs** get a read-only token: they cannot publish checks, so they
  cannot seed a green one.
- `filter=all`: the default returns only the latest check per name.

## Safety rails

- Only on `pull_request`. Pushes to main, schedules and manual runs run
  everything (main is what you deploy).
- Kill switch: repository variable `CI_TASK_SKIP_PASSED=false`.
- Any API error: warn and skip nothing.
- The step is `continue-on-error: true` and never exits non-zero; empty outputs
  mean "false" in every `!= 'true'` condition, so a broken plan runs everything.
- A skipped task publishes no new check: its previous green check stays on the
  commit and the summary links to it. `task-metrics.ts` lists it as
  `skipped: passed in attempt N`.

## Wiring

```yaml
- name: Skip tasks that already passed
  id: skip
  if: github.event_name == 'pull_request'
  continue-on-error: true
  env:
    GITHUB_TOKEN: ${{ github.token }}
    HEAD_SHA: ${{ github.event.pull_request.head.sha }}
    CI_TASK_SKIP_PASSED: ${{ vars.CI_TASK_SKIP_PASSED }}
  run: bun "$CI_SCRIPTS/ci-task.ts" plan
```

Every start step, wait step and **exclusive prep step** of a task gets
`&& steps.skip.outputs.<task> != 'true'`. Shared prep steps get
`&& steps.skip.outputs.<resource> != 'true'`.

Manifest (`.github/ci-tasks.json`, or `CI_TASKS_FILE`):

```json
{ "tasks": [
  { "name": "go-tests", "enabledBy": "GO_CHECKS", "uses": ["postgres", "go"] },
  { "name": "db-suite", "enabledBy": "DB_CHECKS", "uses": ["postgres"] },
  { "name": "e2e",      "enabledBy": "E2E_CHECKS" } ] }
```

`enabledBy` is the env flag the router sets to `"true"` when the task should
run. A resource is skipped only when at least one of its users was skipped and
no enabled user will run.

## The pitfall: gates outside tasks

Anything that can fail and depends on a task's output must live **inside**
that task. Example: a Go diff-coverage check ran as a separate foreground step
after the Go tests task. On a rerun the tests task was skipped, so the
coverage step (same condition) was skipped too, and a coverage drop could have
gone green. Moving the coverage check into the go-tests task fixed it: the task
passes only if the gate passed, and a passed task can safely be skipped.

Audit for this after wiring: list every step whose `if:` includes a
`steps.skip.outputs.*` and ask "can this step fail on its own?" If yes, move it
into the task script.

## When it pays off

Gain = sum of the skipped tasks' durations that were on the critical path.
Verified in one real setup: a rerun skipped 6 green tasks and 47 steps. But
if the failed task is the longest one, the rerun takes about as long as before
(the trunk plus that task), and the start is paid regardless. Skip-on-rerun
saves minutes and flake exposure, not starts. To save starts, avoid reruns:
fix flaky tests, and never rerun whole runs (`--failed` only).

## Reruns: the human side

Put this in the repo's agent instructions:

- `gh run rerun <id> --failed`, never `gh run rerun <id>` or "Re-run all jobs"
  (each job = a start).
- Read why it failed first (`gh pr checks`, then the task check's `output.text`).
- Infra failure (lost runner, exit 137, setup failed): one `--failed` rerun. If
  it fails the same way again, it is capacity; fix the job.
- A test failure unrelated to the change: one rerun to unblock, then open a fix
  for the flaky test. Never loop.
- To force everything to run again: a new push, or `CI_TASK_SKIP_PASSED=false`
  before rerunning.
