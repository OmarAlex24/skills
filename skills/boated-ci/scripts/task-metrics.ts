/**
 * The "per-task metrics" table at the end of the heavy job.
 *
 * Crosses whole-machine samples (machine-sampler.sh, every 2 s) with the
 * window of each background task (ci-task.ts start/end files) and each long
 * foreground step (step-window.sh), and prints per task: seconds, how long its
 * `wait` step blocked, machine CPU (avg/peak), CPU steal and peak memory.
 *
 * Tasks overlap, so CPU is the MACHINE's during the task window, not the
 * task's: a row at 100 % says the machine was full while it ran.
 *
 * CPU accounting from /proc/stat: busy = user+nice+system+irq+softirq
 * (guest is already inside user); steal is reported apart, because it is time
 * the hypervisor did NOT give us. High steal (> ~8 %) means a noisy host: the
 * run is slower for reasons that have nothing to do with your change, so do
 * not compare it with other runs.
 *
 *   bun task-metrics.ts [<RUNNER_TEMP>]      # writes markdown to stdout and the step summary
 *
 * Never fails the job: missing or broken files are reported and it exits 0.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readSkippedMarkers, type SkippedMarker } from "./ci-task-skip";

export interface MachineSample {
  at: number;
  busyTicks: number;
  memAvailableKb: number;
  memTotalKb: number;
  stealTicks: number;
  totalTicks: number;
}

export interface SampleFile {
  cores: number;
  samples: MachineSample[];
}

/** Fractions (0..1) of CPU time between two consecutive samples. */
export interface CpuInterval {
  busy: number;
  from: number;
  steal: number;
  to: number;
}

export type TaskKind = "background" | "foreground";

export interface TaskWindow {
  end?: number | undefined;
  exitCode?: number | undefined;
  kind: TaskKind;
  name: string;
  start: number;
  waited?: number | undefined;
}

export interface WindowStats {
  /** Busy cores on average, weighted by interval overlap. */
  avgCores?: number | undefined;
  /** Average steal fraction (0..1). */
  avgSteal?: number | undefined;
  peakCores?: number | undefined;
  peakMemKb?: number | undefined;
}

/** Compare runs only below this steal (see references/measurement.md). */
export const STEAL_WARNING = 0.08;

const HEADER_RE = /^#\s*cores\s+(\d+)\s*$/;
const WHITESPACE_RE = /\s+/;
/** user nice system idle iowait irq softirq steal (guest is inside user). */
const CPU_FIELDS = 8;
const IDLE = 3;
const IOWAIT = 4;
const STEAL = 7;
const KB_PER_GB = 1024 * 1024;

/**
 * Parse the sampler file. Half-written lines (the runner kills the sampler
 * mid-write) are skipped; without a header cores = 0 and CPU shows as % only.
 */
export function parseSamples(text: string): SampleFile {
  let cores = 0;
  const samples: MachineSample[] = [];
  for (const line of text.split("\n")) {
    const header = HEADER_RE.exec(line);
    if (header) {
      cores = Number(header[1]);
      continue;
    }
    const sample = parseSampleLine(line);
    if (sample) {
      samples.push(sample);
    }
  }
  samples.sort((a, b) => a.at - b.at);
  return { cores, samples };
}

function parseSampleLine(line: string): MachineSample | undefined {
  const fields = line.trim().split(WHITESPACE_RE);
  if (fields[3] !== "cpu" || fields.length < 4 + CPU_FIELDS) {
    return;
  }
  const [at = 0, memTotalKb = 0, memAvailableKb = 0] = fields.slice(0, 3).map(Number);
  const cpu = fields.slice(4, 4 + CPU_FIELDS).map(Number);
  if (![at, memTotalKb, memAvailableKb, ...cpu].every(Number.isFinite)) {
    return;
  }
  const totalTicks = cpu.reduce((sum, value) => sum + value, 0);
  const stealTicks = cpu[STEAL] ?? 0;
  const idleTicks = (cpu[IDLE] ?? 0) + (cpu[IOWAIT] ?? 0);
  return {
    at,
    busyTicks: totalTicks - idleTicks - stealTicks,
    memAvailableKb,
    memTotalKb,
    stealTicks,
    totalTicks,
  };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function cpuIntervals(samples: readonly MachineSample[]): CpuInterval[] {
  const intervals: CpuInterval[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const before = samples[index - 1];
    const after = samples[index];
    if (!(before && after) || after.at <= before.at) {
      continue;
    }
    const total = after.totalTicks - before.totalTicks;
    if (total <= 0) {
      continue;
    }
    intervals.push({
      busy: clamp01((after.busyTicks - before.busyTicks) / total),
      steal: clamp01((after.stealTicks - before.stealTicks) / total),
      from: before.at,
      to: after.at,
    });
  }
  return intervals;
}

/**
 * Machine CPU, steal and memory within [start, end]. An interval counts by the
 * part that overlaps the window; memory by the samples inside it.
 */
export function windowStats(
  file: SampleFile,
  intervals: readonly CpuInterval[],
  start: number,
  end: number
): WindowStats {
  let busyWeighted = 0;
  let stealWeighted = 0;
  let covered = 0;
  let peak: number | undefined;
  for (const interval of intervals) {
    const overlap = Math.min(end, interval.to) - Math.max(start, interval.from);
    if (overlap <= 0) {
      continue;
    }
    busyWeighted += interval.busy * overlap;
    stealWeighted += interval.steal * overlap;
    covered += overlap;
    peak = Math.max(peak ?? 0, interval.busy);
  }
  let peakMemKb: number | undefined;
  for (const sample of file.samples) {
    if (sample.at >= start && sample.at <= end) {
      peakMemKb = Math.max(peakMemKb ?? 0, sample.memTotalKb - sample.memAvailableKb);
    }
  }
  const cores = file.cores > 0 ? file.cores : 1;
  return {
    avgCores: covered > 0 ? (busyWeighted / covered) * cores : undefined,
    avgSteal: covered > 0 ? stealWeighted / covered : undefined,
    peakCores: peak === undefined ? undefined : peak * cores,
    peakMemKb,
  };
}

/** Windows from ci-task.ts (background-steps/) and step-window.sh (step-windows/). */
export function readTaskWindows(runnerTemp: string): TaskWindow[] {
  return [
    ...readWindows(join(runnerTemp, "background-steps"), "background"),
    ...readWindows(join(runnerTemp, "step-windows"), "foreground"),
  ].sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
}

function readWindows(dir: string, kind: TaskKind): TaskWindow[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".start"))
    .sort()
    .flatMap((entry) => {
      const name = entry.slice(0, -".start".length);
      const start = readNumber(join(dir, entry));
      if (start === undefined) {
        return [];
      }
      return [
        {
          end: readNumber(join(dir, `${name}.end`)),
          exitCode: readNumber(join(dir, `${name}.exit`)),
          kind,
          name,
          start,
          waited: readNumber(join(dir, `${name}.waited`)),
        },
      ];
    });
}

function readNumber(file: string): number | undefined {
  if (!existsSync(file)) {
    return;
  }
  const text = readFileSync(file, "utf8").trim();
  const value = Number(text);
  return text !== "" && Number.isFinite(value) ? value : undefined;
}

function coresText(cores: number | undefined, total: number): string {
  if (cores === undefined) {
    return "—";
  }
  if (total <= 0) {
    return `${Math.round(cores * 100)} %`;
  }
  return `${cores.toFixed(1)} (${Math.round((cores / total) * 100)} %)`;
}

function pctText(fraction: number | undefined): string {
  return fraction === undefined ? "—" : `${(fraction * 100).toFixed(1)} %`;
}

function memText(kb: number | undefined): string {
  return kb === undefined ? "—" : `${(kb / KB_PER_GB).toFixed(1)} GB`;
}

function kindText(task: TaskWindow): string {
  if (task.kind === "foreground") {
    return "foreground";
  }
  if (task.exitCode !== undefined && task.exitCode !== 0) {
    return `background, exit ${task.exitCode}`;
  }
  return "background";
}

const row = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;

/** Markdown summary: one row per task plus one for the whole job. */
export function renderMetrics(
  file: SampleFile,
  tasks: readonly TaskWindow[],
  skipped: readonly SkippedMarker[] = []
): string {
  const first = file.samples[0];
  const last = file.samples.at(-1);
  if (!(first && last)) {
    return "### Per-task metrics\n\nNo machine samples: the sampler did not start.\n";
  }
  const intervals = cpuIntervals(file.samples);
  const statsCells = (stats: WindowStats) => [
    coresText(stats.avgCores, file.cores),
    coresText(stats.peakCores, file.cores),
    pctText(stats.avgSteal),
    memText(stats.peakMemKb),
  ];
  const job = windowStats(file, intervals, first.at, last.at);
  const lines = [
    "### Per-task metrics",
    "",
    `Machine: ${file.cores > 0 ? `${file.cores} cores` : "cores unknown"}, ${memText(first.memTotalKb)}; ${file.samples.length} samples. CPU, steal and memory are the whole machine's during each task window (tasks overlap). "From" counts from the first sample.`,
    "",
    row(["Task", "Kind", "From", "Seconds", "Waited at end", "CPU avg", "CPU peak", "Steal avg", "Mem peak"]),
    row(["---", "---", "---:", "---:", "---:", "---:", "---:", "---:", "---:"]),
  ];
  for (const task of tasks) {
    const end = task.end ?? last.at;
    lines.push(
      row([
        task.name,
        kindText(task),
        `+${Math.max(0, task.start - first.at)} s`,
        task.end === undefined
          ? `no end (${Math.max(0, end - task.start)}+)`
          : String(Math.max(0, end - task.start)),
        task.waited === undefined ? "—" : `${task.waited} s`,
        ...statsCells(windowStats(file, intervals, task.start, end)),
      ])
    );
  }
  for (const marker of skipped) {
    lines.push(row([marker.task, `skipped: ${marker.note}`, "—", "—", "—", "—", "—", "—", "—"]));
  }
  lines.push(
    row(["**whole job**", "machine", "+0 s", String(last.at - first.at), "—", ...statsCells(job)])
  );
  if ((job.avgSteal ?? 0) > STEAL_WARNING) {
    lines.push(
      "",
      `> Steal averaged ${pctText(job.avgSteal)} (over ${STEAL_WARNING * 100} %): this VM shared a busy host. Do not use this run to compare configurations.`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function main(runnerTemp = process.argv[2] ?? process.env.RUNNER_TEMP ?? "/tmp"): void {
  const samplesFile = join(runnerTemp, "machine-samples.txt");
  const file = existsSync(samplesFile)
    ? parseSamples(readFileSync(samplesFile, "utf8"))
    : { cores: 0, samples: [] };
  const markdown = renderMetrics(
    file,
    readTaskWindows(runnerTemp),
    readSkippedMarkers(join(runnerTemp, "background-steps"))
  );
  process.stdout.write(markdown);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    appendFileSync(summary, `\n${markdown}`);
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.log(`::warning::task-metrics: ${error instanceof Error ? error.message : String(error)}`);
  }
}
