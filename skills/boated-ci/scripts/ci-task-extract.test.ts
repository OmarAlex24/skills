import { describe, expect, test } from "bun:test";

import {
  cleanLine,
  cleanLog,
  extractBun,
  extractGo,
  extractLocations,
  extractPlaywright,
  extractTap,
  failureExcerpt,
  makeResolver,
  parseCommand,
  renderSections,
  scriptDirs,
} from "./ci-task-extract";

const ROOT = "/home/runner/work/app/app";

function resolverFor(files: readonly string[], dirs: readonly string[] = []) {
  const known = new Set(files);
  return makeResolver({ root: ROOT, dirs, exists: (path) => known.has(path) });
}

describe("cleanLine", () => {
  test("drops ANSI, runner timestamps and \\r progress", () => {
    expect(cleanLine("2026-10-30T19:52:06.6593363Z \u001B[31mred\u001B[0m done")).toBe("red done");
    expect(cleanLine("10%\r50%\rready\r")).toBe("ready");
    expect(cleanLine("x".repeat(5000))).toHaveLength(1002);
  });
});

describe("parseCommand", () => {
  test("reads level, decoded properties and message", () => {
    const command = parseCommand("··::error file=src/a.ts,line=3,title=Bad%3A thing::boom%0Anext");
    expect(command?.level).toBe("error");
    expect(command?.props.get("title")).toBe("Bad: thing");
    expect(command?.message).toBe("boom\nnext");
  });
});

describe("extractBun", () => {
  const log = [
    "bun test v1.2.0",
    "(pass) math > adds [1ms]",
    "12 |   expect(sum(1, 1)).toBe(3);",
    "error: expect(received).toBe(expected)",
    "Expected: 3",
    "Received: 2",
    `      at <anonymous> (${ROOT}/packages/math/sum.test.ts:12:21)`,
    "(fail) math > sums [2ms]",
    " 1 pass",
    " 1 fail",
  ];
  test("lists failed tests and their error block with a location", () => {
    const section = extractBun(log);
    expect(section?.headline).toBe("1 Bun test");
    expect(section?.body).toContain("(fail) math > sums [2ms]");
    expect(section?.body).toContain("Received: 2");
    expect(section?.locations[0]).toMatchObject({ line: 12, col: 21 });
  });
});

describe("extractGo", () => {
  const log = [
    "=== RUN   TestParse",
    "--- FAIL: TestParse (0.00s)",
    "    parse_test.go:42: want 3, got 4",
    "FAIL",
    "FAIL\texample.com/svc/internal/parse\t0.012s",
    "ok  \texample.com/svc/internal/other\t0.010s",
  ];
  test("attributes a bare file to the package that failed", () => {
    const section = extractGo(log);
    expect(section?.headline).toBe("1 Go test");
    expect(section?.locations[0]).toMatchObject({ file: "parse_test.go", line: 42, pkg: "example.com/svc/internal/parse" });
    const resolve = resolverFor(["svc/internal/parse/parse_test.go"]);
    expect(resolve("parse_test.go", "example.com/svc/internal/parse")).toBe("svc/internal/parse/parse_test.go");
  });
});

describe("extractPlaywright", () => {
  test("reads numbered failures", () => {
    const section = extractPlaywright([
      "  1) [chromium] › tests/login.spec.ts:10:5 › login › shows error",
      "    Error: expect(locator).toBeVisible() failed",
      "",
      "  1 failed",
      "  9 passed (30s)",
    ]);
    expect(section?.headline).toBe("1 Playwright test");
    expect(section?.locations[0]).toMatchObject({ file: "tests/login.spec.ts", line: 10, title: "login › shows error" });
  });
});

describe("extractTap", () => {
  test("keeps not-ok lines and their diagnostics", () => {
    const section = extractTap(["ok 1 - a", "not ok 2 - policy denies", "# Failed test 2", "#   have: 1", "ok 3 - c"]);
    expect(section?.count).toBe(1);
    expect(section?.body).toEqual(["not ok 2 - policy denies", "  # Failed test 2", "  #   have: 1"]);
  });
});

describe("extractLocations", () => {
  test("tsc, golangci-lint and eslint stylish formats; warnings ignored", () => {
    const section = extractLocations([
      "src/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "internal/x.go:9:2: unused variable (unused)",
      "src/b.ts:1:1: warning something",
      "/repo/src/c.ts",
      "  4:10  error  'x' is defined but never used  no-unused-vars",
      "",
    ]);
    expect(section?.count).toBe(3);
    expect(section?.locations.map((l) => l.file)).toEqual(["src/app.ts", "internal/x.go", "/repo/src/c.ts"]);
  });
});

describe("failureExcerpt", () => {
  test("falls back to the de-noised tail when nothing is recognised", () => {
    const excerpt = failureExcerpt("::group::setup\nnoise\n::endgroup::\nSomething odd happened\nexit 3\n", resolverFor([]));
    expect(excerpt.headline).toBe("");
    expect(excerpt.text).toContain("Something odd happened");
    expect(excerpt.text).not.toContain("::group::");
  });

  test("turns ::error file= commands into annotations only for repo files", () => {
    const log = "::error file=src/a.ts,line=3::bad\n::error file=/usr/lib/x.ts,line=1::outside\nsrc/a.ts:3:1: bad\n";
    const excerpt = failureExcerpt(log, resolverFor(["src/a.ts"]));
    expect(excerpt.annotations).toHaveLength(1);
    expect(excerpt.annotations[0]).toMatchObject({ path: "src/a.ts", start_line: 3 });
  });

  test("never exceeds the size budget", () => {
    const sections = [{ kind: "tail" as const, heading: "h", count: 0, headline: "", body: Array(5000).fill("y".repeat(100)), locations: [] }];
    expect(renderSections(sections, 2000).length).toBeLessThanOrEqual(2000);
  });
});

describe("paths", () => {
  test("scriptDirs finds cd targets; resolver tries them", () => {
    expect(scriptDirs('cd "$GITHUB_WORKSPACE/services/api" && go test ./...')).toEqual(["services/api"]);
    const resolve = resolverFor(["services/api/main.go"], ["services/api"]);
    expect(resolve("main.go")).toBe("services/api/main.go");
    expect(resolve("node_modules/x/y.js")).toBeNull();
    expect(cleanLog("a\nb\n")).toEqual(["a", "b"]);
  });
});
