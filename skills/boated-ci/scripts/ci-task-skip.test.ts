import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkSummary, taskCheckRun, type CheckContext, type TaskVerdict } from "./ci-task-checks";
import {
  type CheckRunRecord,
  findPassedRun,
  GITHUB_ACTIONS_APP_ID,
  parseManifest,
  planSkips,
  readSkippedMarkers,
  skipDisabledReason,
  skipOutputs,
  writeSkippedMarkers,
} from "./ci-task-skip";

const MANIFEST = parseManifest(
  JSON.stringify({
    tasks: [
      { name: "e2e", enabledBy: "E2E" },
      { name: "go-tests", enabledBy: "GO", uses: ["postgres", "go"] },
      { name: "db-suite", enabledBy: "DB", uses: ["postgres"] },
    ],
  })
);

const CONTEXT: CheckContext = {
  artifactName: "quality-task-logs-1",
  artifactUrl: "",
  attempt: "1",
  headSha: "head",
  jobName: "quality",
  jobUrl: "https://github.com/o/r/actions/runs/77/job/1",
  runId: "77",
  sha: "merge1",
};

const PASSED: TaskVerdict = {
  annotations: [],
  code: 0,
  command: ["bun run e2e"],
  headline: "",
  limit: 900,
  outcome: "passed",
  seconds: 120,
  task: "e2e",
  text: "",
  waited: 3,
};

function check(overrides: Partial<CheckRunRecord> = {}): CheckRunRecord {
  return {
    id: 10,
    name: "quality / e2e",
    app: { id: GITHUB_ACTIONS_APP_ID },
    external_id: "e2e@merge1",
    conclusion: "success",
    html_url: "https://github.com/o/r/runs/10",
    output: { summary: checkSummary(PASSED, CONTEXT) },
    ...overrides,
  };
}

describe("taskCheckRun", () => {
  test("names the check <job> / <task> and keys it by task@merge sha", () => {
    const payload = taskCheckRun(PASSED, CONTEXT);
    expect(payload.name).toBe("quality / e2e");
    expect(payload.external_id).toBe("e2e@merge1");
    expect(payload.head_sha).toBe("head");
    expect(payload.output.title).toBe("passed in 120 s");
    expect(payload.output.annotations).toBeUndefined();
  });

  test("a failure carries its excerpt, headline and annotations", () => {
    const payload = taskCheckRun(
      { ...PASSED, outcome: "failed", code: 1, headline: "3 Bun tests", text: "boom", annotations: [{ path: "a.ts", start_line: 1, end_line: 1, annotation_level: "failure", message: "x" }] },
      CONTEXT
    );
    expect(payload.conclusion).toBe("failure");
    expect(payload.output.title).toBe("failed: 3 Bun tests");
    expect(payload.output.text).toBe("boom");
    expect(payload.output.summary).toContain("gh run rerun 77 --failed");
  });
});

describe("findPassedRun", () => {
  test("accepts only GitHub Actions + exact key + success, and reads run/attempt", () => {
    expect(findPassedRun("quality", "e2e", "merge1", [check()])).toMatchObject({ runId: "77", attempt: 1 });
    expect(findPassedRun("quality", "e2e", "merge1", [check({ app: { id: 999 } })])).toBeNull();
    expect(findPassedRun("quality", "e2e", "merge1", [check({ external_id: "e2e@merge0" })])).toBeNull();
    expect(findPassedRun("quality", "e2e", "merge1", [check({ external_id: "e2e@merge1x" })])).toBeNull();
    expect(findPassedRun("quality", "e2e", "merge1", [check({ conclusion: "failure" })])).toBeNull();
    expect(findPassedRun("quality", "e2e", "merge1", [check({ name: "other / e2e" })])).toBeNull();
  });
});

describe("skipOutputs", () => {
  const env = { E2E: "true", GO: "true", DB: "true" };
  test("a shared resource is skipped only when every enabled user is skipped", () => {
    expect(skipOutputs(MANIFEST, new Set(["go-tests"]), env)).toEqual({
      e2e: "false", "go-tests": "true", "db-suite": "false", postgres: "false", go: "true",
    });
    expect(skipOutputs(MANIFEST, new Set(["go-tests", "db-suite"]), env).postgres).toBe("true");
    // db-suite disabled by the router: go-tests alone decides.
    expect(skipOutputs(MANIFEST, new Set(["go-tests"]), { ...env, DB: "false" }).postgres).toBe("true");
  });
  test("nothing skipped means nothing shared is skipped either", () => {
    expect(skipOutputs(MANIFEST, new Set(), {}).postgres).toBe("false");
  });
});

describe("skipDisabledReason", () => {
  const ok = { GITHUB_EVENT_NAME: "pull_request", HEAD_SHA: "h", GITHUB_SHA: "m", GITHUB_REPOSITORY: "o/r" };
  test("only pull_request, kill switch honoured", () => {
    expect(skipDisabledReason(ok)).toBeNull();
    expect(skipDisabledReason({ ...ok, GITHUB_EVENT_NAME: "push" })).toContain("pull_request");
    expect(skipDisabledReason({ ...ok, CI_TASK_SKIP_PASSED: "FALSE" })).toContain("CI_TASK_SKIP_PASSED");
  });
});

describe("planSkips", () => {
  const env = { GITHUB_EVENT_NAME: "pull_request", HEAD_SHA: "head", GITHUB_SHA: "merge1", GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "78", E2E: "true", GO: "true", DB: "true" };
  test("skips green tasks", async () => {
    const fetch = async (url: string) =>
      new Response(JSON.stringify({ check_runs: url.includes("e2e") ? [check()] : [] }));
    const result = await planSkips({ env, fetch, jobName: "quality", manifest: MANIFEST, print: () => {} });
    expect(result.outputs.e2e).toBe("true");
    expect(result.outputs["go-tests"]).toBe("false");
    expect(result.summary).toContain("passed in run 77 (attempt 1)");
  });
  test("an API error skips nothing", async () => {
    const lines: string[] = [];
    const fetch = async () => new Response("nope", { status: 502 });
    const result = await planSkips({ env, fetch, jobName: "quality", manifest: MANIFEST, print: (l) => lines.push(l) });
    expect(Object.values(result.outputs).every((v) => v === "false")).toBe(true);
    expect(lines[0]).toContain("skipping nothing");
  });
});

describe("manifest and markers", () => {
  test("rejects duplicates and resource/task name clashes", () => {
    expect(() => parseManifest('{"tasks":[{"name":"a"},{"name":"a"}]}')).toThrow("duplicate");
    expect(() => parseManifest('{"tasks":[{"name":"a","uses":["a"]}]}')).toThrow("clashes");
  });
  test("markers round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "skip-"));
    writeSkippedMarkers(dir, [{ task: "e2e", runId: "77", attempt: 1, checkUrl: "u" }], "78");
    expect(readSkippedMarkers(dir)).toEqual([{ task: "e2e", note: "passed in run 77 (attempt 1)", checkUrl: "u" }]);
  });
});
