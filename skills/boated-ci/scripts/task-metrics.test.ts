import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cpuIntervals, parseSamples, readTaskWindows, renderMetrics, windowStats } from "./task-metrics";

/** epoch MemTotal MemAvailable cpu user nice system idle iowait irq softirq steal guest guest_nice */
function line(at: number, busy: number, idle: number, steal: number, availableKb: number) {
  return `${at} 16000000 ${availableKb} cpu  ${busy} 0 0 ${idle} 0 0 0 ${steal} 0 0`;
}

// 8 cores, 2 s between samples = 1600 ticks per interval.
const SAMPLES = [
  "# cores 8",
  line(1000, 0, 0, 0, 12_000_000),
  line(1002, 1600, 0, 0, 8_000_000), // 100 % busy
  line(1004, 2400, 800, 0, 6_000_000), // 50 % busy
  line(1006, 2800, 1600, 400, 10_000_000), // 25 % busy, 25 % steal
  "",
].join("\n");

describe("parseSamples", () => {
  test("busy excludes idle, iowait and steal; steal is kept apart", () => {
    const file = parseSamples("# cores 8\n1000 16000000 8000000 cpu  10 1 2 30 4 5 6 7 99 99\n");
    expect(file.cores).toBe(8);
    expect(file.samples[0]).toMatchObject({ busyTicks: 10 + 1 + 2 + 5 + 6, stealTicks: 7, totalTicks: 65 });
  });
  test("skips half-written lines and sorts", () => {
    const file = parseSamples([line(1004, 5, 5, 0, 1), "1002 160", "junk", line(1000, 1, 1, 0, 1)].join("\n"));
    expect(file.samples.map((s) => s.at)).toEqual([1000, 1004]);
  });
});

describe("cpuIntervals and windowStats", () => {
  const file = parseSamples(SAMPLES);
  const intervals = cpuIntervals(file.samples);
  test("fractions per interval", () => {
    expect(intervals.map((i) => [i.busy, i.steal])).toEqual([[1, 0], [0.5, 0], [0.25, 0.25]]);
  });
  test("weighted by overlap", () => {
    const stats = windowStats(file, intervals, 1001, 1004);
    // 1 s at 100 % + 2 s at 50 % = 2/3 of 8 cores.
    expect(stats.avgCores).toBeCloseTo((2 / 3) * 8);
    expect(stats.peakCores).toBe(8);
    expect(stats.peakMemKb).toBe(10_000_000);
    expect(windowStats(file, intervals, 1004, 1006).avgSteal).toBeCloseTo(0.25);
  });
});

describe("renderMetrics", () => {
  test("one row per task, skipped rows, whole job and a steal warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "metrics-"));
    mkdirSync(join(dir, "background-steps"));
    mkdirSync(join(dir, "step-windows"));
    writeFileSync(join(dir, "background-steps", "e2e.start"), "1000\n");
    writeFileSync(join(dir, "background-steps", "e2e.end"), "1004\n");
    writeFileSync(join(dir, "background-steps", "e2e.exit"), "1\n");
    writeFileSync(join(dir, "background-steps", "e2e.waited"), "2\n");
    writeFileSync(join(dir, "step-windows", "lint.start"), "1002\n");
    const markdown = renderMetrics(parseSamples(SAMPLES), readTaskWindows(dir), [
      { task: "images", note: "passed in attempt 1", checkUrl: "u" },
    ]);
    expect(markdown).toContain("| e2e | background, exit 1 | +0 s | 4 | 2 s |");
    expect(markdown).toContain("| lint | foreground | +2 s | no end (4+) |");
    expect(markdown).toContain("| images | skipped: passed in attempt 1 |");
    expect(markdown).toContain("| **whole job** | machine | +0 s | 6 |");
    expect(markdown).toContain("Steal averaged 8.3 %");
  });
  test("no samples", () => {
    expect(renderMetrics({ cores: 0, samples: [] }, [])).toContain("sampler did not start");
  });
});
