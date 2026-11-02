import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commandSummary, maskSecrets, secretValues, startTask, waitOutput, waitTask } from "./ci-task";

describe("masking", () => {
  test("masks values of secret-looking env vars, longest first", () => {
    const env = { API_TOKEN: "abcdefgh12345", DB_PASSWORD: "abcdefgh", PATH: "/usr/bin:/bin", SHORT_KEY: "abc", EXTRA: "visible-but-listed", CI_TASK_MASK_NAMES: "EXTRA" };
    expect(secretValues(env)).toEqual(["visible-but-listed", "abcdefgh12345", "abcdefgh"]);
    expect(maskSecrets("t=abcdefgh12345 p=abcdefgh path=/usr/bin:/bin x=visible-but-listed", env)).toBe(
      "t=*** p=*** path=/usr/bin:/bin x=***"
    );
  });
});

describe("commandSummary", () => {
  test("drops comments, set -e and summary bookkeeping", () => {
    expect(commandSummary('set -euo pipefail\n# why\ncd app\nbun test\necho x >> "$GITHUB_STEP_SUMMARY"\n')).toEqual(["cd app", "bun test"]);
  });
});

describe("waitOutput", () => {
  test("a failure prints the excerpt inside stop-commands, then the full log", () => {
    const out = waitOutput(
      { task: "e2e", outcome: "failed", code: 1, limit: 5, seconds: 1, waited: 0, command: [], headline: "", text: "::error::x", annotations: [] },
      "log",
      "TOKEN1"
    );
    expect(out).toContain("::stop-commands::TOKEN1\n::error::x\n::TOKEN1::");
    expect(out).toContain("::group::e2e: full log\nlog\n::endgroup::");
  });
});

describe("start + wait (real processes)", () => {
  let temp = "";
  let env: NodeJS.ProcessEnv = {};
  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), "ci-task-"));
    env = { ...process.env, RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: join(temp, "summary.md"), DEPLOY_TOKEN: "s3cr3t-value-123" };
  });
  afterEach(() => rmSync(temp, { recursive: true, force: true }));

  test("a passing task: exit 0, masked log, verdict and window files", async () => {
    startTask("ok-task", 'echo "token is $DEPLOY_TOKEN"\necho done >> "$GITHUB_STEP_SUMMARY"\n', env);
    expect(await waitTask("ok-task", 20, env)).toBe(0);
    const base = join(temp, "background-steps", "ok-task");
    expect(readFileSync(`${base}.log`, "utf8")).toBe("token is ***\n");
    expect(JSON.parse(readFileSync(`${base}.verdict.json`, "utf8")).outcome).toBe("passed");
    expect(existsSync(`${base}.end`)).toBe(true);
    expect(readFileSync(join(temp, "summary.md"), "utf8")).toContain("done");
  });

  test("a failing task: exit 1 with its excerpt", async () => {
    startTask("bad-task", 'echo "src/a.ts(1,2): error TS1: nope"\nexit 3\n', env);
    expect(await waitTask("bad-task", 20, env)).toBe(1);
    const verdict = JSON.parse(readFileSync(join(temp, "background-steps", "bad-task.verdict.json"), "utf8"));
    expect(verdict).toMatchObject({ outcome: "failed", code: 3, headline: "1 error with file and line" });
  });

  test("timeout and never-started", async () => {
    startTask("slow-task", "sleep 5\n", env);
    expect(await waitTask("slow-task", 1, env)).toBe(1);
    expect(await waitTask("ghost", 1, env)).toBe(1);
    const ghost = JSON.parse(readFileSync(join(temp, "background-steps", "ghost.verdict.json"), "utf8"));
    expect(ghost.outcome).toBe("not-started");
  });
});
