#!/usr/bin/env bash
# Marks the start or end of a long FOREGROUND step (lint, typecheck, build,
# unit tests) so task-metrics.ts lists it next to the background tasks, with
# the machine's CPU, steal and memory during its window.
#
#   bash step-window.sh <name> start|end
#
# Writes the epoch to $RUNNER_TEMP/step-windows/<name>.start|.end. A step that
# fails before `end` shows as "no end". Never fails: measuring must not turn a
# step red.
set -u

name="${1:-}"
edge="${2:-}"
if ! [[ "$name" =~ ^[a-z0-9-]+$ ]] || ! [[ "$edge" =~ ^(start|end)$ ]]; then
  echo "::warning::Usage: step-window.sh <name> start|end"
  exit 0
fi
dir="${RUNNER_TEMP:-/tmp}/step-windows"
{ mkdir -p "$dir" && date +%s >"${dir}/${name}.${edge}"; } 2>/dev/null ||
  echo "::warning::Could not mark ${name}.${edge}"
exit 0
