---
name: boat-ci
description: "Migrate CI jobs from hosted runners to boat.dev sandboxes. Use when the user wants to run GitHub Actions on Boat (runs-on: boat), move GitLab/CircleCI/Buildkite jobs to Boat to cut runner cost, run Docker or KVM inside CI, or debug a Boat CI job that was refused, paused or timed out."
license: MIT
compatibility: "Requires a Boat account, a paid plan for runs-on: boat, Git, and network access to boat.dev."
metadata:
  author: Omar Espinosa
  version: "0.1.0"
  repo: https://github.com/OmarAlex24/skills/tree/main/skills/boat-ci
  install: npx skills add OmarAlex24/skills --skill boat-ci
  agents: claude-code, codex, cursor, opencode
  tags: ci, boat, github-actions, sandbox
  description_es: "Migra jobs de CI a sandboxes de boat.dev, con runs-on: boat o con el CLI desde cualquier CI."
  summary_es: Migra un pipeline de CI a Boat sin cambiar lo que prueba, con límites de costo y un camino de reversa.
---

# Boat CI

Move a CI job to Boat without changing what the job actually tests. There are two paths, and picking the right one is most of the work.

## Decide the path first

| Path | Use when | Cost model |
| --- | --- | --- |
| `runs-on: boat` | CI is GitHub Actions and the team can install the Boat CI GitHub App | Per-second VM time; jobs above plan starts may cost $0.03–$0.07 each |
| CLI from any CI | GitLab, CircleCI, Buildkite, or one step inside a GitHub job | Per-second VM time, plus the runner that drives the CLI |

Do not migrate every job at once. Pick one job that is slow, needs Docker or `/dev/kvm`, or is expensive on hosted runners. Prove it, then move the rest.

## Before touching workflows

1. List the jobs and record for each: runner, duration, CPU/RAM needs, services (`services:` containers), secrets, artifacts, caches, and whether it needs a VM (Android, QEMU, Firecracker).
2. Confirm the repo can use Boat:
   - `boat limits` shows the sandbox types available right now.
   - A paid plan is required for `runs-on: boat`.
   - Public repositories do not run on Boat until they are explicitly allowed.
3. Identify secrets. `runs-on: boat` jobs read GitHub Actions secrets but **do not** read the Boat environment. CLI jobs read the environment or `-e KEY=VALUE`.
4. Record the current green run and its duration. That is the baseline.

## Path A: GitHub Actions with `runs-on: boat`

### Setup

```bash
boat ci connect              # bill the wallet in scope
boat ci connect --org acme   # or bill an organization
```

Authorize the GitHub App, then change one label:

```yaml
jobs:
  test:
    runs-on: boat             # was: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test
```

Sizes: `boat-small` (2 vCPU / 4 GB), `boat` (4 vCPU / 8 GB), `boat-large` (8 vCPU / 16 GB), `boat-xlarge` (16 vCPU / 32 GB, needs the $100 plan or higher).

Options go after `/`:

```yaml
runs-on: boat-large/from=ci-base/debug
```

- `from=<snapshot>` starts from a saved snapshot with the toolchain and dependencies already installed.
- `debug` keeps a failed sandbox for 30 minutes so you can `boat ssh <id>` into it.

### What already works

- `services:` containers, `container:`, `actions/cache`, `actions/upload-artifact`, GitHub Actions secrets.
- `docker build`, `docker run`, `docker compose`.
- Every sandbox has `/dev/kvm`, so Android emulators and nested VMs work.

### What does not

- Boat does not pass the Boat environment, secret files, GitHub token or model provider keys into the job. Use GitHub Actions secrets.
- Docker images are pulled again at each job start, even with `from=`. Keep large images out of the hot path or create a container for each image in the snapshot (`docker create --name keep-<x> <image>`), because a saved snapshot only keeps images a container uses.
- Jobs from public repositories are refused unless allowed per GitHub account and user.

### Prepare a snapshot (one time)

Install the toolchain and dependencies once, then save it:

```bash
id=$(boat new --json | jq -r 'select(.event == "ready") | .id')
boat exec "$id" --timeout 600 -- bash -lc 'sudo apt-get update && sudo apt-get install -y postgresql-client'
boat exec "$id" --timeout 600 -- bash -lc 'docker pull postgres:16 && docker create --name keep-postgres postgres:16'
boat snapshot "$id" ci-base
boat delete "$id" --yes
```

Run the same steps to update `ci-base`; saving with the same name replaces it. Ten saved snapshots are free.

## Path B: CLI from any CI

Create a CI key and store it as a secret:

```bash
boat api-key create github-ci --preset ci --ttl 90d
gh secret set BOAT_API_KEY
```

The `ci` preset can create, use and delete sandboxes. Rotate it with `boat api-key rotate <id>`.

Minimal GitHub Actions workflow:

```yaml
name: Tests on Boat
on: [pull_request, push]

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      BOAT_API_KEY: ${{ secrets.BOAT_API_KEY }}
    steps:
      - uses: actions/checkout@v4

      - name: Install the Boat CLI
        run: |
          mkdir -p "$HOME/.local/bin"
          curl -fsSL "https://boat.dev/api/boat/cli/download?platform=linux-x64&channel=prod" \
            -o "$HOME/.local/bin/boat"
          chmod +x "$HOME/.local/bin/boat"
          echo "$HOME/.local/bin" >> "$GITHUB_PATH"

      - name: Sign in
        run: printf '%s' "$BOAT_API_KEY" | boat login --key-stdin --json

      - name: Create a sandbox
        id: sandbox
        run: |
          id=$(boat new --from ci-base --type small --ttl 1800 --json | jq -r 'select(.event == "ready") | .id')
          test -n "$id"
          echo "id=$id" >> "$GITHUB_OUTPUT"

      - name: Copy the code
        run: |
          git archive --format=tar.gz -o /tmp/src.tgz HEAD
          boat scp /tmp/src.tgz "${{ steps.sandbox.outputs.id }}:/home/user/src.tgz"
          boat exec "${{ steps.sandbox.outputs.id }}" "mkdir -p repo && tar xzf src.tgz -C repo"

      - name: Run the tests
        run: |
          set +e
          boat exec "${{ steps.sandbox.outputs.id }}" --cwd repo --timeout 600 --stream -- bash -lc 'npm ci && npm test'
          code=$?
          boat scp "${{ steps.sandbox.outputs.id }}:/home/user/repo/junit.xml" ./junit.xml || true
          exit $code

      - name: Delete the sandbox
        if: always() && steps.sandbox.outputs.id != ''
        run: boat delete "${{ steps.sandbox.outputs.id }}" --yes --json
```

Or collapse create/copy/run/delete into one command:

```bash
boat run --from ci-base --type small --push . -- bash -lc 'npm ci && npm test'
```

`boat run` exits with the test exit code, prints the cost and deletes the sandbox. A cancelled job deletes it too. If the runner dies, Boat stops the sandbox within 15 minutes.

Rules that keep this safe:

- Use the sandbox ID in every command. The `current` alias does not work because each step is a new shell.
- `--ttl 1800` is the safety net if the delete step never runs.
- `if: always()` on delete. Billing stops at delete.
- `set +e` before the test command, copy artifacts, then `exit $code` so the real failure survives.
- `--timeout 600 --stream` for normal suites; `--timeout 0` only for suites that legitimately run long.

## Cost guardrails

- Start with `small`; move to `default` only if memory or CPU is the measured bottleneck. A `small` sandbox costs $0.018/h, a `default` $0.036/h.
- Add `strategy.max-parallel` to matrices so a 30-job matrix does not burn starts. The $20 plan includes 12 starts/minute, 60/hour, 200/day.
- A refused start does not count as a start. Use `--fail-fast` when a missing machine should fail the job immediately instead of waiting.
- Jobs above the included starts cost $0.03–$0.07 each. For short jobs at high volume, paid starts can dominate the bill; compare against the current runner before migrating the whole matrix.
- Use `boat ci` and `boat ci --repo <owner>/<repo> --state failed` to inspect wait time, run time, cost and refusals.

## When starts become the limit

Each GitHub job that gets a runner costs one start, so a workflow with many parallel jobs per push runs into the start caps (per minute first, then per day) long before VM hours. If the user hits the cap, pays for extra starts, or asks to merge jobs, stop adding `max-parallel` patches and use the companion skill **boated-ci** (https://omaralex.dev/skills/boated-ci/, `npx skills add OmarAlex24/skills --skill boated-ci`). It audits starts per day, hour and minute, and consolidates the jobs into one heavy job with parallel tasks, one check per task and reruns that skip what already passed.

## Secrets

- `runs-on: boat`: GitHub Actions secrets only.
- CLI path: set secrets on a Boat environment and start with `--environment <name>`, or pass one value with `-e KEY=VALUE`. Verify with `boat exec "$id" 'echo ${DATABASE_URL:+set}'`.
- Never put the API key in the workflow file or in a command-line argument. Pipe it with `--key-stdin`.

## Verify

1. The migrated job is green on the same commit that was green before.
2. Duration is within the baseline, or the difference is explained (cold Docker pulls, snapshot start).
3. Logs show the test command and its real exit code; a failing test fails the job.
4. Artifacts arrive (JUnit, coverage, screenshots).
5. The sandbox is deleted at the end: `boat list --all` shows no `ci-` sandbox left behind.
6. `boat ci job <id>` shows a cost you are willing to pay.

## Rollback

Keep the old job definition in the same PR, commented or behind a second workflow. Roll back by reverting the `runs-on` line (or the CLI step) and leaving the Boat snapshot in place. Do not delete the snapshot until the new path has run for a week.

## Common failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| Job refused, "no paid plan" | Free trial or no plan | Start a plan; re-run |
| Job refused, unknown label | Typo or unsupported option | Check `boat ci`; use `boat`, `boat-small`, `boat-large`, `boat-xlarge` |
| Job paused by plan limit | Start limit exhausted | Wait for reset, raise the plan, cap `max-parallel`, or consolidate jobs with boated-ci |
| Out of memory warning | Process exceeded size + swap | Use a larger size or add swap |
| Docker image missing after `from=` | Snapshot only keeps images a container uses | `docker create --name keep-x <image>` before saving |
| Public PR refused | Public repos are off by default | `boat ci public <account> on --users "me"` |
| Tests pass but job fails | Exit code lost by a pipeline | `set +e`, capture `$?`, `exit $code` |
| Sandbox left running | Delete step skipped | Add `if: always()` and `--ttl` |

## Output

Report back with: path chosen, files changed, baseline vs new duration, cost per run, secrets moved, snapshot name, and the rollback command. Do not claim the migration works without a green run.
