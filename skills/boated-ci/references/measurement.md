# Measuring the heavy job

Once everything shares one machine, the questions change: is the machine full?
which task is last? is it worth a bigger size? You cannot answer them from
step durations alone, because tasks overlap. Measure the machine and slice it
by task window.

## The pieces

| Script | Role |
| --- | --- |
| `machine-sampler.sh` | First steps of the job. Every 2 s appends `epoch MemTotal MemAvailable <cpu line of /proc/stat>` to `$RUNNER_TEMP/machine-samples.txt`, detached until the job ends. |
| `ci-task.ts start/wait` | Writes each background task's window: `.start`, `.end`, `.exit`, `.waited`. |
| `step-window.sh <name> start|end` | Same for long foreground steps (lint, typecheck, build, unit). |
| `task-metrics.ts` | End of job. Table per task: from (+s), seconds, waited at end, machine CPU avg/peak (cores and %), **steal avg**, memory peak; plus a whole-job row. Writes it to the step summary. |

Upload `machine-samples.txt` and the window files as an artifact so you can
recompute across many runs later.

CPU math (from /proc/stat deltas): `busy = user+nice+system+irq+softirq`,
`steal` apart, `idle+iowait` free. Rows are the MACHINE during the task window,
not the task: tasks overlap.

## How to read the table

- **Whole job CPU avg > ~85 %**: the machine is the bottleneck. A bigger size
  will help (one real case: 8 vCPU at 90-99 % -> 16 vCPU went from ~603 s to
  ~450 s).
- **CPU avg < ~50 % and one task finishes last**: size will not help; move that
  task earlier or split its work (same real case: starting coverage right after
  install instead of after build took ~450 s to ~380 s).
- **Waited at end** large for one task: it is the critical path. Small for all:
  the trunk is the critical path.
- **Memory peak** close to MemTotal: you are one change from exit 137. Add a
  memory guard or size up before it bites.
- **Steal avg > ~8 %**: noisy neighbour. This run is slower for reasons
  unrelated to your change. Do not use it to compare configurations. The
  script prints a warning line.

## Noise you will meet on per-start VMs

From one real measurement campaign on a per-start provider:
- Some VMs run with **15-29 % CPU steal**; those runs took **+50-70 %** time.
  Steal turned out to be the main source of run-to-run variance.
- About **3.5 % of VMs boot with slow network/disk for the first ~4-5 min**:
  cache restore at 2-4 MB/s instead of 11-36 MB/s, install ~250 s instead of
  ~50 s. Some providers hydrate disks lazily: wait for hydration before heavy
  IO if they expose it, or restore caches after cheap CPU work.
- Dashboard VM hours were ~1.7x the sum of job durations (boot/teardown,
  minimum billing, or size multipliers). Treat job time as a lower bound.

## Experiment protocol

1. Fix the hypothesis and the metric: usually **seconds after install**
   (job end minus install end). It removes boot and cache-restore noise.
2. Make the knob a repository variable (`CI_WEB_TEST_CONCURRENCY`,
   `CI_RUNS_ON_QUALITY`), so variants need no code change.
3. Run variants **sequentially**, not N in parallel. Parallel runs land on the
   same contended hosts at the same time and inherit correlated steal.
4. At least 5 runs per variant. Discard runs with steal > ~8 % or with the
   slow-boot signature (install > 3x median), and say how many you discarded.
5. Compare medians and failure counts. A faster variant that fails 3 of 5 runs
   on timing-sensitive tests is slower in practice (every failure costs a rerun
   and a start).
6. Each measurement rerun costs starts. Rerun only the measured job
   (`--failed` with a deliberate failing step, or `--job <id>`), never whole runs.

Example results table (durations illustrative; the failure pattern is from a
real experiment):

| Variant | Runs kept | Median after install | Failures |
| --- | --- | --- | --- |
| concurrency 4 (baseline) | 5/5 | 312 s | 0 |
| concurrency 8 | 5/5 | 298 s | 3 (timing flakes) |
| concurrency 6 | 5/5 | 300 s | 0 |
| concurrency 6 + higher e2e priority | 4/5 (1 steal 21 %) | 304 s | 0 |

Decision: 6. Not 8, despite the median.
