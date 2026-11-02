/**
 * Failure extractors used by ci-task-extract.ts, one per kind of tool output.
 * Each receives the cleaned log (no ANSI, no runner timestamps) and returns a
 * section with the lines that explain the failure plus the code locations it
 * points at, or null when it recognises nothing.
 *
 * Covered: bun test, go test (failures and panics), Playwright `list` reporter,
 * TAP / pgTAP, `file:line:col` diagnostics (tsc, eslint, oxlint, golangci-lint,
 * go vet, ruff, mypy...) and, as a fallback, the de-noised tail of the log.
 *
 * To support another tool, add an extractor with the same signature and list
 * it in EXTRACTORS (ci-task-extract.ts).
 */

const TAIL_LINES = 150;

export type SectionKind =
  | "bun"
  | "errors"
  | "go"
  | "locations"
  | "playwright"
  | "tail"
  | "tap";

/** A place in the code the log points at, before it becomes a repo path. */
export interface LogLocation {
  readonly col?: number | undefined;
  readonly file: string;
  readonly line: number;
  readonly message: string;
  /** Go import path of the package, to resolve a bare `foo_test.go:12`. */
  readonly pkg?: string | undefined;
  readonly title?: string | undefined;
}

export interface Section {
  readonly body: readonly string[];
  /** Number of failures found; 0 when the section is context only. */
  readonly count: number;
  readonly heading: string;
  /** "3 Bun tests": used in the check title; empty for context sections. */
  readonly headline: string;
  readonly kind: SectionKind;
  readonly locations: readonly LogLocation[];
}

// --- bun test ----------------------------------------------------------------

const BUN_RESULT_RE = /^\((pass|fail|skip|todo)\) /;
const BUN_FAIL_RE = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/;
const BUN_FRAME_START_RE = /^\s*\d+ \| /;
const BUN_ERROR_RE = /^(?:error: |# Unhandled error)/;
const BUN_SCRIPT_EXIT_RE = /^error: script ".*" exited with code/;
const BUN_STACK_RE = /^\s+at (?:.*\()?([^\s()]+):(\d+):(\d+)\)?$/;
const MAX_BLOCK_LINES = 60;

function bunBoundary(line: string): boolean {
  return (
    BUN_RESULT_RE.test(line) ||
    /^(?:::|##\[)(?:end)?group/.test(line) ||
    line.startsWith("::error") ||
    line.startsWith("bun test v") ||
    /^\s*\d+ (?:pass|fail)$/.test(line) ||
    /^Ran \d+ tests?/.test(line)
  );
}

function startsBunBlock(line: string): boolean {
  return (
    BUN_FRAME_START_RE.test(line) ||
    (BUN_ERROR_RE.test(line) && !BUN_SCRIPT_EXIT_RE.test(line))
  );
}

/** From the code frame or `error:` up to its `(fail)` or the next result. */
function readBunBlock(lines: readonly string[], from: number): string[] {
  const block: string[] = [];
  for (let i = from; i < lines.length && block.length < MAX_BLOCK_LINES; i++) {
    const line = lines[i] ?? "";
    if (i > from && bunBoundary(line)) {
      if (BUN_FAIL_RE.test(line)) {
        block.push(line);
      }
      break;
    }
    block.push(line);
  }
  return trimBlank(block);
}

function bunLocation(block: readonly string[]): LogLocation | null {
  const message = block.find((line) => BUN_ERROR_RE.test(line)) ?? "";
  for (const line of block) {
    const frame = BUN_STACK_RE.exec(line);
    if (frame?.[1]?.includes("/") && !frame[1].includes("node_modules")) {
      return {
        file: frame[1],
        line: Number(frame[2]),
        col: Number(frame[3]),
        message,
      };
    }
  }
  return null;
}

/**
 * Failed Bun tests and the error of each. Several `bun test` processes may
 * run at once and interleave their output, so error blocks are found by shape
 * (code frame, `error:`, stack) and the `(fail)` lines separately.
 */
export function extractBun(lines: readonly string[]): Section | null {
  const fails = unique(
    lines.filter((line) => BUN_FAIL_RE.test(line)).map((line) => line.trim())
  );
  const blocks: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!startsBunBlock(lines[i] ?? "")) {
      continue;
    }
    const block = readBunBlock(lines, i);
    i += Math.max(block.length - 1, 0);
    if (block.some((line) => BUN_ERROR_RE.test(line))) {
      blocks.push(block);
    }
  }
  const distinct = uniqueBlocks(blocks);
  if (fails.length === 0 && distinct.length === 0) {
    return null;
  }
  return {
    kind: "bun",
    heading:
      fails.length > 0
        ? `Bun: ${plural(fails.length, "test failed", "tests failed")}`
        : "Bun: errors",
    count: fails.length || distinct.length,
    headline:
      fails.length > 0
        ? plural(fails.length, "Bun test", "Bun tests")
        : plural(distinct.length, "Bun error", "Bun errors"),
    body: [...fails, ...distinct.flatMap((block) => ["", ...block])],
    locations: distinct.flatMap((block) => bunLocation(block) ?? []),
  };
}

// --- go test -----------------------------------------------------------------

const GO_FAIL_RE = /^(\s*)--- FAIL: (\S+)/;
const GO_PKG_FAIL_RE = /^FAIL\s+(\S+)(?:\s|$)/;
const GO_TEST_LOCATION_RE = /^\s+([\w.-]+\.go):(\d+): (.*)$/;
const GO_FRAME_RE = /^\t(\S+\.go):(\d+)(?: \+0x[0-9a-f]+)?$/;
const MAX_PANIC_LINES = 40;

function readIndented(
  lines: readonly string[],
  from: number,
  max: number
): string[] {
  const block = [lines[from] ?? ""];
  for (let i = from + 1; i < lines.length && block.length < max; i++) {
    const line = lines[i] ?? "";
    if (!/^(?:\s{2,}|\t)/.test(line) || GO_FAIL_RE.test(line)) {
      break;
    }
    block.push(line);
  }
  return block;
}

function readPanic(lines: readonly string[], from: number): string[] {
  const block: string[] = [];
  for (let i = from; i < lines.length && block.length < MAX_PANIC_LINES; i++) {
    const line = lines[i] ?? "";
    if (
      i > from &&
      (GO_PKG_FAIL_RE.test(line) || /^(?:ok|---|===) /.test(line))
    ) {
      break;
    }
    block.push(line);
  }
  return trimBlank(block);
}

function goTestLocations(block: readonly string[]): LogLocation[] {
  return block.flatMap((line) => {
    const match = GO_TEST_LOCATION_RE.exec(line);
    return match?.[1]
      ? [{ file: match[1], line: Number(match[2]), message: match[3] ?? "" }]
      : [];
  });
}

function goPanicLocation(block: readonly string[]): LogLocation | null {
  const message = block[0] ?? "";
  for (const line of block) {
    const frame = GO_FRAME_RE.exec(line);
    if (
      frame?.[1] &&
      !frame[1].includes("/go/src/") &&
      !frame[1].includes("/libexec/src/")
    ) {
      return { file: frame[1], line: Number(frame[2]), message };
    }
  }
  return null;
}

interface GoScan {
  readonly blocks: string[][];
  readonly packages: string[];
  readonly pending: LogLocation[];
  readonly resolved: LogLocation[];
  topLevel: number;
}

/** A bare `foo_test.go:12` gets the package of the `FAIL\t<pkg>` that closes it. */
function closePackage(scan: GoScan, pkg: string): void {
  scan.packages.push(pkg);
  for (const location of scan.pending.splice(0)) {
    scan.resolved.push({ ...location, pkg });
  }
}

function scanGoLine(scan: GoScan, lines: readonly string[], i: number): number {
  const line = lines[i] ?? "";
  const fail = GO_FAIL_RE.exec(line);
  if (fail) {
    const block = readIndented(lines, i, 30);
    scan.blocks.push(block);
    scan.pending.push(...goTestLocations(block));
    scan.topLevel += fail[1] === "" ? 1 : 0;
    return block.length - 1;
  }
  if (line.startsWith("panic: ")) {
    const block = readPanic(lines, i);
    scan.blocks.push(block);
    const location = goPanicLocation(block);
    if (location) {
      scan.resolved.push(location);
    }
    return block.length - 1;
  }
  const pkg = GO_PKG_FAIL_RE.exec(line)?.[1];
  if (pkg) {
    closePackage(scan, pkg);
  }
  return 0;
}

export function extractGo(lines: readonly string[]): Section | null {
  const scan: GoScan = {
    blocks: [],
    packages: [],
    pending: [],
    resolved: [],
    topLevel: 0,
  };
  for (let i = 0; i < lines.length; i++) {
    i += scanGoLine(scan, lines, i);
  }
  if (scan.blocks.length === 0 && scan.packages.length === 0) {
    return null;
  }
  const count = scan.topLevel || scan.packages.length;
  return {
    kind: "go",
    heading: `Go: ${plural(count, "test failed", "tests failed")}`,
    count,
    headline: plural(count, "Go test", "Go tests"),
    body: [
      ...scan.blocks.flatMap((block) => [...block, ""]),
      ...unique(scan.packages).map((pkg) => `FAIL\t${pkg}`),
    ],
    locations: [...scan.resolved, ...scan.pending],
  };
}

// --- Playwright (list / line reporter) ----------------------------------------

const PW_HEADER_RE =
  /^\s{2}(\d+)\) \[[^\]]+\] › (\S+?):(\d+):(\d+) › (.*?)\s*$/;
const PW_SUMMARY_RE =
  /^\s{2}\d+ (?:failed|flaky|passed|skipped|interrupted|did not run)\b/;
const PW_WEBSERVER_RE =
  /Timed out waiting \d+ ?ms from config\.webServer|Error: Process from config\.webServer/;

function readPlaywrightBlock(lines: readonly string[], from: number): string[] {
  const block = [lines[from] ?? ""];
  for (
    let i = from + 1;
    i < lines.length && block.length < MAX_BLOCK_LINES;
    i++
  ) {
    const line = lines[i] ?? "";
    if (PW_HEADER_RE.test(line) || PW_SUMMARY_RE.test(line)) {
      break;
    }
    block.push(line);
  }
  return trimBlank(block);
}

function playwrightSummary(lines: readonly string[]): string[] {
  const start = lines.findIndex((line) => /^\s{2}\d+ failed\b/.test(line));
  if (start === -1) {
    return [];
  }
  const summary: string[] = [];
  for (const line of lines.slice(start, start + 40)) {
    if (summary.length > 0 && !/^\s{2}/.test(line)) {
      break;
    }
    summary.push(line);
  }
  return summary;
}

/** The numbered failure blocks of the reporter, plus a webServer that never came up. */
export function extractPlaywright(lines: readonly string[]): Section | null {
  const blocks: string[][] = [];
  const locations: LogLocation[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const header = PW_HEADER_RE.exec(lines[i] ?? "");
    if (!header || seen.has(header[1] ?? "")) {
      continue;
    }
    seen.add(header[1] ?? "");
    const block = readPlaywrightBlock(lines, i);
    blocks.push(block);
    locations.push({
      file: header[2] ?? "",
      line: Number(header[3]),
      col: Number(header[4]),
      message: block.find((line) => /^\s*Error: /.test(line))?.trim() ?? "",
      title: header[5],
    });
  }
  const webServer = lines.filter((line) => PW_WEBSERVER_RE.test(line));
  if (blocks.length === 0 && webServer.length === 0) {
    return null;
  }
  const count = blocks.length || 1;
  return {
    kind: "playwright",
    heading: `Playwright: ${plural(count, "test failed", "tests failed")}`,
    count,
    headline: plural(count, "Playwright test", "Playwright tests"),
    body: [
      ...unique(webServer),
      ...blocks.flatMap((block) => [...block, ""]),
      ...playwrightSummary(lines),
    ],
    locations,
  };
}

// --- TAP / pgTAP ---------------------------------------------------------------

const TAP_NOT_OK_RE = /^\s*not ok \d+/;
const TAP_DIAG_RE = /^\s*# /;

function tapLine(line: string): string {
  return line.replace(/\s*\+$/, "").trim();
}

export function extractTap(lines: readonly string[]): Section | null {
  const body: string[] = [];
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (TAP_NOT_OK_RE.test(line)) {
      count++;
      body.push(tapLine(line));
      for (
        let j = i + 1;
        j < lines.length && j <= i + 15 && TAP_DIAG_RE.test(lines[j] ?? "");
        j++
      ) {
        body.push(`  ${tapLine(lines[j] ?? "")}`);
      }
    } else if (/^\s*# Looks like you failed/.test(line)) {
      body.push(tapLine(line));
    }
  }
  if (count === 0) {
    return null;
  }
  return {
    kind: "tap",
    heading: `TAP: ${plural(count, "test failed", "tests failed")}`,
    count,
    headline: plural(count, "TAP test", "TAP tests"),
    body: unique(body),
    locations: [],
  };
}

// --- file:line:col (tsc, eslint, oxlint, golangci-lint, go vet, ruff...) ------

const FILE = String.raw`[\w@.+\-/]+\.[A-Za-z]{1,5}`;
const COLON_LOCATION_RE = new RegExp(
  String.raw`^\s*(?:vet: )?(${FILE}):(\d+):(\d+)(?::| -) ?(.+)$`
);
const PAREN_LOCATION_RE = new RegExp(
  String.raw`^\s*(${FILE})\((\d+),(\d+)\): (.+)$`
);
const STYLISH_FILE_RE = new RegExp(String.raw`^(/?${FILE})$`);
const STYLISH_ROW_RE = /^\s+(\d+):(\d+)\s+error\s+(.+)$/;
const NOT_AN_ERROR_RE = /^(?:warning|notice|note|info|hint)\b|^NOTICE:/i;
const MAX_LOCATION_LINES = 100;

function locationFrom(line: string): LogLocation | null {
  const match = COLON_LOCATION_RE.exec(line) ?? PAREN_LOCATION_RE.exec(line);
  if (!match?.[1] || match[1].includes("node_modules")) {
    return null;
  }
  const message = (match[4] ?? "").trim();
  if (NOT_AN_ERROR_RE.test(message)) {
    return null;
  }
  return {
    file: match[1],
    line: Number(match[2]),
    col: Number(match[3]),
    message,
  };
}

/** eslint's `stylish` format: the path alone on a line, its rows below. */
function stylishLocations(lines: readonly string[]): LogLocation[] {
  const found: LogLocation[] = [];
  let file = "";
  for (const line of lines) {
    const header = STYLISH_FILE_RE.exec(line);
    if (header?.[1]) {
      file = header[1];
      continue;
    }
    const row = STYLISH_ROW_RE.exec(line);
    if (row && file) {
      found.push({
        file,
        line: Number(row[1]),
        col: Number(row[2]),
        message: row[3]?.trim() ?? "",
      });
    } else if (line.trim() === "") {
      file = "";
    }
  }
  return found;
}

export function extractLocations(lines: readonly string[]): Section | null {
  const locations = [
    ...lines.flatMap((line) => locationFrom(line) ?? []),
    ...stylishLocations(lines),
  ];
  if (locations.length === 0) {
    return null;
  }
  const body = unique(
    locations.map(
      (loc) => `${loc.file}:${loc.line}:${loc.col ?? 1}: ${loc.message}`
    )
  );
  return {
    kind: "locations",
    heading: `${plural(body.length, "error", "errors")} with file and line`,
    count: body.length,
    headline: plural(
      body.length,
      "error with file and line",
      "errors with file and line"
    ),
    body: body.slice(0, MAX_LOCATION_LINES),
    locations,
  };
}

// --- Generic tail ----------------------------------------------------------------

const NOISE_RE = [
  /^(?:::|##\[)(?:end)?group/,
  /^\((?:pass|skip|todo)\) /,
  /^ok\s+\S+\s/,
  /^\?\s+\S+\s+\[no test files\]/,
  /^(?:Setting up|Processing triggers|Unpacking|Preparing to unpack|Selecting previously|Get:\d+|Hit:\d+) /,
  /^\(Reading database \.\.\./,
  /^\s*[·°×✓]+\s*$/,
];

/** The last useful lines of the log: the fallback when no extractor matches. */
export function extractTail(
  lines: readonly string[],
  keep = TAIL_LINES
): Section {
  const useful: string[] = [];
  for (const line of lines) {
    if (NOISE_RE.some((re) => re.test(line))) {
      continue;
    }
    if (line.trim() === "" && useful.at(-1)?.trim() === "") {
      continue;
    }
    useful.push(line);
  }
  return {
    kind: "tail",
    heading: `Last ${Math.min(keep, useful.length)} log lines (noise removed)`,
    count: 0,
    headline: "",
    body: trimBlank(useful.slice(-keep)),
    locations: [],
  };
}

// --- Utilities -------------------------------------------------------------------

export function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueBlocks(blocks: readonly string[][]): string[][] {
  const seen = new Set<string>();
  return blocks.filter((block) => {
    const key = block.join("\n");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function trimBlank(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim() === "") {
    start++;
  }
  while (end > start && (lines[end - 1] ?? "").trim() === "") {
    end--;
  }
  return lines.slice(start, end);
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
