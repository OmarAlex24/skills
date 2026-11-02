import { describe, expect, test } from "bun:test";

import { classifyJob, type JobRecord, PLANS, parseArgs, recommend, summarize } from "./audit-starts";

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    name: "build",
    labels: ["boat-large"],
    conclusion: "success",
    createdAt: "2026-10-31T15:00:10Z",
    startedAt: "2026-10-31T15:00:40Z",
    completedAt: "2026-10-31T15:06:40Z",
    runnerId: 1,
    runnerName: "boat-1",
    runAttempt: 1,
    runId: 1,
    event: "pull_request",
    workflow: "ci",
    ...overrides,
  };
}

describe("classifyJob", () => {
  test("a job with a runner is a start", () => {
    expect(classifyJob(job())).toBe("started");
  });
  test("skipped by if: and API-created check runs are free", () => {
    expect(classifyJob(job({ runnerId: null, runnerName: null, conclusion: "skipped" }))).toBe("free");
    expect(classifyJob(job({ runnerId: null, runnerName: null, labels: [], name: "ci / e2e" }))).toBe("free");
  });
  test("cancelled while queued is reported apart", () => {
    expect(classifyJob(job({ runnerId: null, runnerName: null, conclusion: "cancelled" }))).toBe("queued-no-runner");
  });
});

describe("summarize", () => {
  const jobs = [
    job({ runId: 1, name: "lint", completedAt: "2026-10-31T15:01:40Z" }),
    job({ runId: 1, name: "test" }),
    job({ runId: 2, name: "test", createdAt: "2026-10-31T15:00:50Z", conclusion: "cancelled" }),
    job({ runId: 3, name: "test", createdAt: "2026-11-01T09:30:00Z", runAttempt: 2 }),
    job({ runId: 3, name: "ci / e2e", labels: [], runnerId: null, runnerName: null }),
  ];
  const summary = summarize(jobs);
  test("counts starts, peaks, reruns and cancels", () => {
    expect(summary.starts).toBe(4);
    expect(summary.runsWithStarts).toBe(3);
    expect(summary.peakMinute).toEqual({ at: "2026-10-31T15:00", count: 3 });
    expect(summary.byDay.map((d) => [d.day, d.starts, d.runs])).toEqual([["2026-10-31", 3, 2], ["2026-11-01", 1, 1]]);
    expect(summary.rerunStarts).toBe(1);
    expect(summary.cancelledAfterStart).toBe(1);
    expect(summary.byJob[0]).toMatchObject({ name: "test", starts: 3 });
  });
});

describe("recommend", () => {
  const base = summarize([job()]);
  const withDay = (starts: number, runs: number, perRunJobs = starts) => ({
    ...base,
    starts: perRunJobs,
    runsWithStarts: runs,
    peakDay: { day: "d", starts, runs, queuedNoRunner: 0, peakHour: { at: "", count: 0 }, peakMinute: { at: "", count: 0 } },
  });
  const caps = PLANS["100"] as NonNullable<(typeof PLANS)["100"]>;
  test("fits / tight / over / router", () => {
    expect(recommend(withDay(100, 50), caps).level).toBe("fits");
    expect(recommend(withDay(700, 300), caps).level).toBe("tight");
    expect(recommend(withDay(964, 250), caps).level).toBe("over");
    expect(recommend(withDay(1700, 1600), caps).level).toBe("router");
  });
});

describe("parseArgs", () => {
  test("plan presets and overrides", () => {
    const args = parseArgs(["--repo", "o/r", "--plan", "20", "--cap-day", "150", "--days", "1"], new Date("2026-11-01T00:00:00Z"));
    expect(args.caps).toMatchObject({ day: 150, hour: 60, minute: 12 });
    expect(args.since.toISOString()).toBe("2026-10-31T00:00:00.000Z");
    expect(() => parseArgs(["--repo", "bad"])).toThrow("--repo");
  });
});
