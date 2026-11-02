#!/usr/bin/env bash
# Memory guard for a background task on a SMALL machine.
#
# On a big runner a memory-hungry background task (coverage, e2e) can start
# right after install and overlap the foreground trunk. On a smaller runner its
# peak must not stack on top of another peak (typically the typecheck), so the
# task script calls this first:
#
#   bash wait-for-marker.sh <task> [marker-file]
#
# - MemTotal >= WAIT_MIN_MEMORY_GB: returns at once (big machine).
# - WAIT_FOR_MARKER != "true" (the step that writes the marker will not run):
#   returns at once.
# - Otherwise waits until the marker file exists (the guarded step writes it
#   from a `trap ... EXIT`, pass or fail), up to WAIT_MAX_SECONDS.
#
# Writes one summary line with the seconds it waited. Never fails: waiting must
# not turn the task red.
#
# Env: WAIT_FOR_MARKER, WAIT_MIN_MEMORY_GB (24), WAIT_MAX_SECONDS (600),
#      WAIT_POLL_SECONDS (2), WAIT_MEMINFO (/proc/meminfo, for tests).
set -u

task="${1:-task}"
marker="${2:-${RUNNER_TEMP:-/tmp}/typecheck.done}"
meminfo="${WAIT_MEMINFO:-/proc/meminfo}"
min_gb="${WAIT_MIN_MEMORY_GB:-24}"
max_seconds="${WAIT_MAX_SECONDS:-600}"
poll="${WAIT_POLL_SECONDS:-2}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"

note() {
  echo "- ${task}: $1" | tee -a "$summary"
}

total_kb="$(awk '/^MemTotal:/ {print $2}' "$meminfo" 2>/dev/null)"
if ! [[ "$total_kb" =~ ^[0-9]+$ ]]; then
  note "no MemTotal in ${meminfo}; starting without waiting"
  exit 0
fi
total_gb="$(awk -v kb="$total_kb" 'BEGIN {printf "%.1f", kb / 1048576}')"
if [ "$total_kb" -ge $((min_gb * 1048576)) ]; then
  note "starting without waiting (${total_gb} GB machine)"
  exit 0
fi
if [ "${WAIT_FOR_MARKER:-}" != "true" ]; then
  note "${total_gb} GB machine, but the guarded step will not run; starting"
  exit 0
fi

start=$SECONDS
while [ ! -e "$marker" ]; do
  if [ $((SECONDS - start)) -ge "$max_seconds" ]; then
    note "waited ${max_seconds}s for ${marker} (${total_gb} GB machine); starting anyway"
    exit 0
  fi
  sleep "$poll"
done
note "waited $((SECONDS - start))s for ${marker} (${total_gb} GB machine, under ${min_gb} GB)"
exit 0
