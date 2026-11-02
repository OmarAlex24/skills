# Auditing machine starts

Measure before you change anything. You need four numbers per window: starts
per **day**, peak per **hour**, peak per **minute**, and starts **per run**,
broken down by job name, runner label and event.

## The quick way

```bash
bun scripts/audit-starts.ts --repo owner/name --days 7 --plan 100
bun scripts/audit-starts.ts --repo owner/name --since 2026-10-29T00:00:00Z --until 2026-10-30T00:00:00Z
bun scripts/audit-starts.ts --repo owner/name --days 7 --label '^boat' --json > starts.json
```

- `--plan 20|100|500|2000` loads a Boat plan's caps; override with
  `--cap-day/--cap-hour/--cap-minute` for any other provider.
- `--label <regex>` keeps only jobs whose runner labels match (useful while
  migrating, when some jobs still run elsewhere).
- `--by started` buckets by `started_at` instead of `created_at`.
- Read-only. Uses `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`.

Pick a representative window: at least one busy weekday. Weekends make every
CI look cheap. Also audit the single heaviest day you can find; caps are hit
on peaks, not on averages.

## What counts as a start

From `GET /repos/{o}/{r}/actions/runs/{id}/jobs?filter=all` (all attempts):

| Job shape | Start? |
| --- | --- |
| `runner_id` or `runner_name` set | **Yes, 1 start.** Even if it was cancelled one second later. |
| labels set, not skipped, no runner (cancelled while queued) | Maybe. Some providers start provisioning on the `queued` webhook and bill it. Report apart as an upper bound. |
| `conclusion: skipped` (job-level `if:` false) | No. Never queued. |
| no labels at all | No. The jobs API also lists check runs created through the Checks API (for example per-task checks `job / task`) as if they were jobs. Counting them inflates starts several-fold. |

Bucket by `created_at` (queue time, when a per-start provider starts
provisioning). The difference with `started_at` is the boot time; it matters
only for the per-minute peak.

## Doing it by hand with `gh`

```bash
# runs created on one day (the API returns at most 1000 per query: split by hour if needed)
gh api -X GET "repos/OWNER/REPO/actions/runs" -f created=2026-10-29 -f per_page=100 --paginate \
  --jq '.workflow_runs[] | [.id, .event, .name] | @tsv' > runs.tsv

# jobs that got a runner, with their queue minute
cut -f1 runs.tsv | while read -r id; do
  gh api "repos/OWNER/REPO/actions/runs/$id/jobs?filter=all&per_page=100" \
    --jq '.jobs[] | select(.runner_id != null) | [.created_at[0:16], .name, (.labels|join(","))] | @tsv'
done > starts.tsv

wc -l < starts.tsv                                # starts that day
cut -f1 starts.tsv | cut -c1-13 | sort | uniq -c | sort -rn | head -1   # peak hour
cut -f1 starts.tsv | sort | uniq -c | sort -rn | head -1               # peak minute
cut -f2 starts.tsv | sort | uniq -c | sort -rn | head -20              # per job name
```

Caveat: runs are listed by creation date. A rerun today of a run created
yesterday is missed unless the window starts a day earlier.

## Reading the result

- **Starts per run** is the lever. A PR run with 4 jobs costs 4 starts; the
  same work in one job costs 1. Multiply by runs per day.
- **Short jobs** (< 3 min average) are the cheapest to fold in: the start and
  setup dominate their cost. Typical: change detection, docs gates, linters,
  aggregate "all green" jobs, per-image matrix legs.
- **Cancelled after start**: each one paid a start for nothing. Usually
  `cancel-in-progress: true` on pushes to the main branch.
- **Rerun starts** (`run_attempt > 1`): full reruns re-pay every job. Use
  `gh run rerun <id> --failed`.
- **Minute peaks** above the cap with a day total well under it mean fan-out
  bursts (matrix, many jobs per run, several PRs pushed together). Consolidation
  fixes it; `max-parallel` only spreads it.
- **Job hours by label** vs the plan's included VM hours. Providers may apply
  size multipliers and count boot/teardown; in one real migration the
  dashboard showed ~1.7x the job-time estimate. Treat job time as a lower bound.

Projection for the plan: `starts/day after = runs/day x starts per run after`.
Use the heaviest day, then add reruns (~5-10 %) and the scheduled runs.
