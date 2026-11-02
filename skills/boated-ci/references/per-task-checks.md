# Per-task check runs

Folding N jobs into one loses something real: the PR used to show N named
checks, each with its own short log. Without a fix, a red `quality` means
"open a 100k+ line log and search". Humans hate it; coding agents that read CI
to fix PRs burn their context on it (one real heavy-job log was ~195k lines).

`ci-task.ts publish` restores it: one check run `<job> / <task>` per task.

## What a task check contains

| Field | Value |
| --- | --- |
| `name` | `quality / e2e` (`CHECK_JOB_NAME` + task). Never the bare job name: that is the required check. |
| `head_sha` | The PR head commit (`pull_request.head.sha`), which is where the PR UI shows checks. On push, `github.sha`. |
| `external_id` | `<task>@<github.sha>`. On a PR, github.sha is the test merge commit. This is the skip-on-rerun key. |
| `conclusion` | `success` / `failure` (timeout and not-started are failures). |
| `output.title` | `passed in 212 s`, `failed: 3 Bun tests`, `failed: 2 Go tests, 1 error with file and line`, `did not finish within 1500 s`. |
| `output.summary` | Outcome line, the first 12 command lines of the task, `gh run rerun <id> --failed`, links to the job log and the log artifact, and a machine marker `<!-- boated-ci run=<id> attempt=<n> -->`. |
| `output.text` | The trimmed failure only (markdown, <= 60,000 chars). |
| `annotations` | <= 50, only for files that exist in the repo, `annotation_level: failure`. |
| `details_url` | The heavy job's log (looked up via the jobs API; falls back to the run). |

Reading it from a terminal or an agent:

```bash
gh pr checks <pr>                                     # find the red `quality / <task>`
gh api repos/OWNER/REPO/check-runs/<id> --jq .output.text   # just the trimmed failure
```

Put those two lines in the repo's agent instructions (AGENTS.md/CLAUDE.md):
"read the task check before reading the job log".

## The extractors

`ci-task-extract.ts` + `ci-task-extractors.ts`, pure functions with tests:

| Extractor | Recognises |
| --- | --- |
| bun | `(fail)` lines and error blocks (code frame, `error:`, stack), even interleaved from parallel `bun test` processes |
| go | `--- FAIL:` blocks, panics (first non-stdlib frame), `FAIL\t<pkg>`; resolves bare `x_test.go:12` through the package import path |
| playwright | `list` reporter numbered failures, `config.webServer` startup timeouts, the final summary |
| tap | `not ok N` + `#` diagnostics (pgTAP and any TAP producer) |
| locations | `file:line:col: msg` (golangci-lint, go vet, eslint unix, oxlint, ruff, mypy), `file(line,col): msg` (tsc), eslint `stylish` |
| errors | `::error file=...,line=...::msg` workflow commands the task printed |
| tail | fallback: last 150 lines without group markers, passing tests, apt noise |

Add a tool by writing `extractX(lines): Section | null` and listing it in
`EXTRACTORS`. Write a test with a real (anonymised) log snippet first; extractors
rot silently when the tool changes its output.

## The wait step output

On failure `wait` prints the trimmed failure **first**, wrapped in
`::stop-commands::<random>` so `::error` lines inside it are not turned into
duplicate annotations, then the full log inside a collapsed group. So
`gh run view <id> --log-failed` also starts with the useful part.

## Secrets: mask before storing

Background output never passes through the runner's log masking (the runner
masks what a step prints, and the task is not a step). If you upload task logs
as artifacts or put excerpts in check runs, you must mask them yourself:

1. `start` pipes the task's stdout/stderr through `ci-task.ts mask` before it
   reaches disk. It masks the values of env vars whose names look secret
   (`TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, `PRIVATE`, `*_KEY`,
   `DSN`, `DATABASE_URL`) plus any names in `CI_TASK_MASK_NAMES`, using the
   start step's env.
2. `wait` masks again with its own env and rewrites the stored log, so the
   uploaded artifact is the masked one.
3. Verdict text, command lines and annotations are masked too.

Limits: values shorter than 8 characters are not masked (too many false
positives); secrets that are never in either env (fetched at runtime by the
script, e.g. from a vault) are invisible to both (the mask pipe's env is
fixed when the task starts). Keep runtime-fetched secrets out of task output
entirely, or fetch them in a foreground step and pass them through the start
step's `env:`. `CI_TASK_MASK=false` disables the
pipe (debugging only).

## Permissions and forks

The job needs `checks: write`. Fork PRs get a read-only `GITHUB_TOKEN`: the
publish step warns and the job result is unchanged. Publishing never fails the
job: the task's `wait` step already decided it.

The jobs API (`/actions/runs/<id>/jobs`) lists these check runs as pseudo-jobs
without labels or runner. Any tool that counts starts from that API must ignore
them (`audit-starts.ts` does).
