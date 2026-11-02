# Sizing and cost

Prices and limits change. Everything here was collected around 2026-11-01:
**verify current pricing on the provider's site before deciding.**

## Billing models

| Model | You pay for | Implication for CI design |
| --- | --- | --- |
| Per minute (GitHub-hosted, most third-party runner services, per-minute self-hosted fleets) | machine-minutes x size multiplier | Parallel jobs are nearly free in money: same minutes, more machines. Cancel early to save money. |
| Per start + included VM hours (Boat-style plans) | a quota of machine starts per minute/hour/day, plus VM time | Every job with a runner costs a start. Cancelling does not refund it. Fewer, bigger jobs. |
| Own hardware / box reuse | the boxes | Starts are free if a box serves many jobs; see box-reuse-router.md. |

## Boat plans (motivating case)

Each GitHub job that gets a runner = 1 start. A job skipped by `if:` costs
nothing. A job started and then cancelled already paid its start. Per-second
VM billing.

| Plan / month | Sandboxes at once | Starts / min | Starts / hour | Starts / day | VM hours included |
| --- | --- | --- | --- | --- | --- |
| $20 | 100 | 12 | 60 | 200 | 555 |
| $100 | 300 | 30 | 210 | 840 | 2,777 |
| $500 | 1,000 | 65 | 420 | 1,680 | 13,888 |
| $2,000 | 2,000 | 90 | 600 | 2,400 | 55,555 |

Size classes seen: `boat-small` 2 vCPU/4 GB, `boat` 4/8, `boat-large` 8/16,
`boat-xlarge` 16/32. Size multipliers for VM hours were not published at the
time; a working assumption was small 0.5x, default 1x, large 2x, xlarge 4x.
Check the dashboard after a few days and recompute.

Useful provider tips (from the box-reuse article, see credits): wait for disk
hydration before heavy IO, use the provider's ignore file to keep the snapshot
small, refresh any auto-stop timer on long jobs.

## Per-minute example: a self-hosted-label provider

Classes like `micro`, `small`, `standard`, `memory`, `large`, `xl`, selected
with labels such as `["self-hosted", "<provider>-large"]`. Per-minute providers
make the many-jobs layout cheap, but check reliability: one real migration away
from such a provider happened because the provider failed to prepare machines
(it reported its own setup check as failed and left jobs **queued for up to
24 h**; 42 such cases in ~20 h). Track "queued > 10 min" as a provider SLO
whatever the billing model.

## Choosing the heavy job's size

Price per run on per-start + VM-hours plans is roughly
`1 start + duration x size multiplier`. Bigger is often cheaper per run if the
job is CPU bound:

| Size | Duration | VM-hour units (assumed multipliers) |
| --- | --- | --- |
| large (8 vCPU, 2x) | 603 s | 0.34 |
| xlarge (16 vCPU, 4x) | 450 s | 0.50 |
| xlarge + better ordering | ~380 s | 0.42 |

Here xlarge costs ~25 % more VM time per run but saves ~3.7 minutes of PR
latency per run. Whether that is worth it depends on the included hours: check
`job hours/month x multiplier` against the plan before switching. Keep the size
in a repository variable so it can be changed back in seconds.

Pick the smallest size where:
1. memory peak (task-metrics) < ~80 % of MemTotal with all tasks overlapped;
2. whole-job CPU avg is not pinned at 95-100 % (if it is, the next size up
   usually pays for itself in latency);
3. median after install meets your PR latency target.

## Budget check (do this once per change)

```
starts/day  = runs/day x starts/run + reruns + scheduled
peak/hour   = from audit (busiest hour), not starts/day / 24
peak/minute = from audit; fan-out bursts dominate this
VM hours    = sum(job duration x multiplier) x ~1.7 safety (boot, teardown)
```

Target <= ~50 % of each cap on the heaviest day: reruns, a release day, or a
dependency-bot wave can double a day.
