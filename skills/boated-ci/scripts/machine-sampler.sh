#!/usr/bin/env bash
# Samples the WHOLE machine every 2 s until the job ends, for task-metrics.ts.
#
# Background tasks overlap, so CPU cannot be attributed to one process: we
# measure the machine and task-metrics.ts slices the samples by each task's
# window (ci-task.ts start/end files, step-window.sh marks).
#
# Usage (first steps of the job; never fails the job):
#   bash machine-sampler.sh [output-file]     # default $RUNNER_TEMP/machine-samples.txt
#
# Output: a header `# cores <n>` and one line per sample with raw counters:
#   <epoch> <MemTotal kB> <MemAvailable kB> cpu <user> <nice> <system> <idle> <iowait> <irq> <softirq> <steal> ...
# Deltas (busy %, steal %) are computed by task-metrics.ts, which has tests.
# Field 8 of the `cpu` line is STEAL: time the hypervisor gave our vCPU to
# someone else. On shared hosts it was the main source of run-to-run variance.
#
# It is started with nohup and without the step's stdin/stdout, so the step
# returns immediately and the loop survives later steps; the runner kills it
# when the job ends. Cost: one awk every 2 s.
set -uo pipefail

INTERVAL="${SAMPLER_INTERVAL_SECONDS:-2}"

if [ "${1:-}" = "loop" ]; then
  while :; do
    awk -v now="$(date +%s)" '
      FILENAME == "/proc/meminfo" && /^MemTotal:/ { total = $2 }
      FILENAME == "/proc/meminfo" && /^MemAvailable:/ { available = $2 }
      FILENAME == "/proc/stat" && $1 == "cpu" { cpu = $0 }
      END { print now, total, available, cpu }
    ' /proc/meminfo /proc/stat
    sleep "$INTERVAL"
  done
fi

out="${1:-${RUNNER_TEMP:-/tmp}/machine-samples.txt}"
if [ ! -r /proc/stat ] || [ ! -r /proc/meminfo ]; then
  echo "::warning::No /proc/stat or /proc/meminfo (not Linux?): machine not sampled."
  exit 0
fi

echo "# cores $(nproc)" >"$out"
nohup bash "$0" loop </dev/null >>"$out" 2>/dev/null &
echo "Sampling the machine every ${INTERVAL}s in the background (into ${out})"
