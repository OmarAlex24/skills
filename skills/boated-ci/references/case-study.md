# Case study: a production TypeScript/Go monorepo

Real numbers from one migration (October-November 2026). Names removed.

## Why it moved

The CI ran on a per-minute runner provider with self-hosted labels. The
provider intermittently failed to prepare machines: it marked its own setup
check as failed and left the GitHub job **queued for up to 24 h** (42 cases in
about 20 h). A watchdog workflow that cancelled and re-queued stuck jobs became
a workflow of its own. The team moved to a per-start provider (Boat).

## The plan's constraints ($100 plan)

840 starts/day, 210/hour, 30/minute, 300 sandboxes at once, ~2,777 VM hours
included. Per-second billing; size multipliers unpublished (assumed small
0.5x, default 1x, large 2x, xlarge 4x). After a few days the dashboard's VM
hours were ~1.7x the team's job-time estimate.

## Before

A classic layout: a change-detection router job, then separate jobs for
TypeScript quality (lint, typecheck, build, unit), live database suites,
Playwright smoke tests, Go checks and tests, image builds (a matrix, one
machine per image), Python checks, coverage, an LLM benchmark, a docs gate in
its own workflow, and an aggregate "all green" job. Main-branch test jobs had
job-level `cancel-in-progress: true` groups (designed for per-minute billing).

- ~3.9 starts per CI run on average.
- Heaviest day: **964 starts** (> 840 cap); peak minute **42** (> 30 cap).
- One day on main: 31 of 52 push runs ended cancelled; 55 quality jobs had
  started and were then cancelled by the next push. Every one paid a start.
- Four days of reruns: 60 runs rerun, 85 attempts, 350 starts; 80 of them
  came from two measurement campaigns that reran whole runs.

## What changed (in order)

1. **Images**: one machine per image -> one bake building all images in
   parallel on one heavy machine (~239 starts/day saved).
2. **Aggregate `ci` job removed**; branch protection requires each real job,
   later only the heavy job.
3. **Main concurrency**: workflow-level group, `cancel-in-progress` only for
   PRs. Replaying the bad day: 70 of 216 starts saved (~105/day). Push-to-done
   median 16.6 -> 18.4 min, but p90 28.7 -> 26.6 and max 73.6 -> 32.7.
4. **Fold small jobs in as background tasks**: ml (40 s of work on its own
   machine), Go, live DB suites, Playwright, LLM bench, coverage, PR image
   builds. Install paid once instead of twice (median 60 s, p90 130 s each).
5. **Router as the first step** of the heavy job. Replaying a day: ~490 ->
   ~295 starts.
6. **Reruns**: `gh run rerun --failed` only, written into the agent
   instructions.

Result: **1 start per PR run**, ~2 on main (quality + deploy), 2 nightly.
Estimated heaviest day ~270 starts (**32 % of the cap**). A 48 h audit right after
(weekend included, some old jobs still in flight) measured 126 starts, peak
minute 8.

## Per-task results and reruns

- The heavy job's log reached ~195k lines; agents fixing PRs read it. One
  check run `<job> / <task>` per task with the trimmed failure (extractors for
  bun, go, playwright, tsc, eslint/oxlint, golangci-lint, pgTAP, generic tail)
  fixed it. Task logs masked before upload.
- Skip-on-rerun keyed by `<task>@<merge sha>` from the Actions app. Verified:
  a rerun skipped 6 green tasks (47 steps). A Go diff-coverage gate had to move
  inside its task so a skipped task could not hide it. Gain is small when the
  failed task is the longest one.

## Sizing and tuning

| Change | Job time |
| --- | --- |
| boat-large (8 vCPU/16 GB), CPU 90-99 % | ~603 s |
| boat-xlarge (16 vCPU/32 GB) | ~450 s |
| coverage starts right after install (memory guard waits for typecheck under 24 GB) | ~380 s (~300 s after install) |

Experiment, 4 configs x 5 runs: web test concurrency 8 failed 3 of 5 runs on
timing-sensitive tests; 6 failed 0 of 5 and was not slower; raising
Playwright's CPU priority showed no gain.

Measurement lessons: some VMs had 15-29 % CPU steal (+50-70 % time); ~3.5 % of
VMs booted with slow network/disk for the first 4-5 min (cache 2-4 MB/s vs
11-36, install ~250 s vs ~50 s). Compare runs only under ~8 % steal, run
experiments sequentially (parallel ones landed on contended hosts), and use
time after install as the metric.

## Lessons

- Audit per day, per hour AND per minute: both the day cap (964 > 840) and the
  minute cap (42 > 30) were exceeded on the same heavy day.
- Make every runner class a repository variable: switching provider or size
  during an incident took a variable change, not a PR.
- Write the rerun rules into the agent instructions: most reruns were
  requested by the same token humans and agents share, so the API cannot tell
  who wasted the starts.
