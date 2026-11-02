/**
 * Trims a background task's log down to what explains its failure.
 *
 * Why: once many tasks share one job, the job log gets huge (one real job
 * reached ~195k lines), and humans and coding agents that read CI to fix a PR
 * drown in it. `ci-task.ts wait` prints this excerpt above the full log, and
 * `ci-task.ts publish` puts it in the task's check run (`output.text`) with
 * annotations pointing at file and line.
 *
 * Pipeline: clean the log, read `::error` workflow commands, run the
 * extractors (ci-task-extractors.ts), fall back to the de-noised tail, render
 * to markdown within GitHub's limits and turn locations into annotations.
 * Everything here is pure: file existence is injected as a function.
 */

import {
  extractBun,
  extractGo,
  extractLocations,
  extractPlaywright,
  extractTail,
  extractTap,
  type LogLocation,
  type Section,
  unique,
} from "./ci-task-extractors";

export {
  extractBun,
  extractGo,
  extractLocations,
  extractPlaywright,
  extractTail,
  extractTap,
} from "./ci-task-extractors";
export type { LogLocation, Section } from "./ci-task-extractors";

/** GitHub accepts 65,535 chars in `output.text`; the margin is for headers. */
export const MAX_TEXT_LENGTH = 60_000;
/** Annotations accepted per check-run API call. */
export const MAX_ANNOTATIONS = 50;
const MAX_LINE_LENGTH = 1000;
const MAX_ANNOTATION_MESSAGE = 4000;

export interface CheckAnnotation {
  readonly annotation_level: "failure";
  readonly end_column?: number | undefined;
  readonly end_line: number;
  readonly message: string;
  readonly path: string;
  readonly start_column?: number | undefined;
  readonly start_line: number;
  readonly title?: string | undefined;
}

export interface FailureExcerpt {
  readonly annotations: readonly CheckAnnotation[];
  /** "3 Bun tests"; empty when only the tail was kept. */
  readonly headline: string;
  readonly text: string;
}

/** Repo-relative path for a file the log mentions, or null if not in the repo. */
export type PathResolver = (file: string, pkg?: string) => string | null;

const TIMESTAMP_RE = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
const ANSI_RE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

/** A line as a human sees it: no ANSI, no runner timestamp, no \r progress. */
export function cleanLine(raw: string): string {
  const afterCarriage = raw.slice(raw.lastIndexOf("\r", raw.length - 2) + 1);
  const timed = afterCarriage.replace(/\r$/, "").replace(TIMESTAMP_RE, "");
  const line = timed.replace(ANSI_RE, "");
  return line.length > MAX_LINE_LENGTH
    ? `${line.slice(0, MAX_LINE_LENGTH)} …`
    : line;
}

export function cleanLog(log: string): string[] {
  const lines = log.split("\n").map(cleanLine);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

// --- Workflow commands (::error file=…::) --------------------------------------

export interface WorkflowCommand {
  readonly level: "error" | "notice" | "warning";
  readonly message: string;
  readonly props: ReadonlyMap<string, string>;
}

// Playwright prints it after its progress dots on the same line, and its
// `title` may contain bare colons: the properties end at the first `::`.
const COMMAND_RE = /^[^:]*?::(error|warning|notice)(?: (.*?))?::(.*)$/;

function decodeData(value: string): string {
  return value
    .replaceAll("%0D", "\r")
    .replaceAll("%0A", "\n")
    .replaceAll("%25", "%");
}

function decodeProperty(value: string): string {
  return decodeData(value).replaceAll("%3A", ":").replaceAll("%2C", ",");
}

export function parseCommand(line: string): WorkflowCommand | null {
  const match = COMMAND_RE.exec(line);
  if (!match) {
    return null;
  }
  const [, level = "error", rawProps = "", message = ""] = match;
  const props = new Map<string, string>();
  for (const pair of rawProps.split(",")) {
    const equals = pair.indexOf("=");
    if (equals > 0) {
      props.set(
        pair.slice(0, equals).trim(),
        decodeProperty(pair.slice(equals + 1))
      );
    }
  }
  return {
    level: level === "warning" || level === "notice" ? level : "error",
    message: decodeData(message),
    props,
  };
}

function commandLocation(command: WorkflowCommand): LogLocation | null {
  const file = command.props.get("file");
  const line = Number(command.props.get("line"));
  if (!file || !Number.isInteger(line) || line < 1) {
    return null;
  }
  const col = Number(command.props.get("col"));
  return {
    file,
    line,
    col: Number.isInteger(col) && col > 0 ? col : undefined,
    message: command.message.trim(),
    title: command.props.get("title"),
  };
}

/** `::error::` lines the task printed itself (with or without a file). */
export function extractErrorCommands(lines: readonly string[]): Section | null {
  const body: string[] = [];
  const locations: LogLocation[] = [];
  for (const line of lines) {
    const command = parseCommand(line);
    if (command?.level !== "error") {
      continue;
    }
    const location = commandLocation(command);
    if (location) {
      locations.push(location);
    } else {
      const first = command.message
        .split("\n")
        .find((text) => text.trim() !== "");
      if (first && !/^\s*at /.test(first)) {
        body.push(first.trim());
      }
    }
  }
  if (body.length === 0 && locations.length === 0) {
    return null;
  }
  return {
    kind: "errors",
    heading: "Errors reported by the task",
    count: 0,
    headline: "",
    body: unique(body),
    locations,
  };
}

// --- Assembly ------------------------------------------------------------------

/** Order matters only for rendering; every extractor runs. Add yours here. */
const EXTRACTORS = [
  extractBun,
  extractGo,
  extractPlaywright,
  extractTap,
  extractLocations,
];

export function failureSections(lines: readonly string[]): Section[] {
  const found = EXTRACTORS.flatMap((extract) => extract(lines) ?? []);
  // Do not repeat what another section already shows; with no body left the
  // `::error` section still contributes its annotations.
  const errors = extractErrorCommands(lines);
  const shown = new Set(
    found.flatMap((section) => section.body.map((line) => line.trim()))
  );
  const head = errors
    ? [{ ...errors, body: errors.body.filter((line) => !shown.has(line)) }]
    : [];
  return found.length > 0 ? [...head, ...found] : [...head, extractTail(lines)];
}

const FENCE = "````";

function renderSection(section: Section, budget: number): string {
  const open = `### ${section.heading}\n\n${FENCE}text\n`;
  const close = `${FENCE}\n`;
  const lines: string[] = [];
  let used = open.length + close.length;
  for (const [index, line] of section.body.entries()) {
    if (used + line.length + 1 > budget - 80) {
      lines.push(`… (${section.body.length - index} more lines in the full log)`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return `${open}${lines.join("\n")}\n${close}`;
}

/** Sections as markdown, never longer than `max` characters. */
export function renderSections(
  sections: readonly Section[],
  max = MAX_TEXT_LENGTH
): string {
  const parts: string[] = [];
  let left = max;
  for (const section of sections) {
    if (section.body.length === 0) {
      continue;
    }
    if (left < 400) {
      parts.push("… (more sections in the full log)\n");
      break;
    }
    const rendered = renderSection(section, left);
    parts.push(rendered);
    left -= rendered.length + 1;
  }
  return parts.join("\n").slice(0, max);
}

function toAnnotation(location: LogLocation, path: string): CheckAnnotation {
  const message = location.message || location.title || "failed here";
  return {
    path,
    start_line: location.line,
    end_line: location.line,
    start_column: location.col,
    end_column: location.col,
    annotation_level: "failure",
    message: message.slice(0, MAX_ANNOTATION_MESSAGE),
    title: location.title?.slice(0, 255),
  };
}

export function annotationsFor(
  sections: readonly Section[],
  resolve: PathResolver
): CheckAnnotation[] {
  const seen = new Set<string>();
  const annotations: CheckAnnotation[] = [];
  for (const location of sections.flatMap((section) => section.locations)) {
    const path = resolve(location.file, location.pkg);
    const key = `${path}:${location.line}`;
    if (!path || seen.has(key) || annotations.length >= MAX_ANNOTATIONS) {
      continue;
    }
    seen.add(key);
    annotations.push(toAnnotation(location, path));
  }
  return annotations;
}

function headlineOf(sections: readonly Section[]): string {
  return sections
    .filter((section) => section.count > 0)
    .slice(0, 2)
    .map((section) => section.headline)
    .join(", ");
}

export function failureExcerpt(
  log: string,
  resolve: PathResolver,
  max = MAX_TEXT_LENGTH
): FailureExcerpt {
  const sections = failureSections(cleanLog(log));
  return {
    headline: headlineOf(sections),
    text: renderSections(sections, max),
    annotations: annotationsFor(sections, resolve),
  };
}

// --- Paths -------------------------------------------------------------------------

export interface ResolverOptions {
  /** Directories the task `cd`s into, relative to the repo root. */
  readonly dirs: readonly string[];
  readonly exists: (repoPath: string) => boolean;
  /** GITHUB_WORKSPACE: the repo root on the runner. */
  readonly root: string;
}

const RUNNER_CHECKOUT_RE = /\/_work\/[^/]+\/[^/]+\/(.+)$/;

function repoRelative(file: string, root: string): string | null {
  if (!file.startsWith("/")) {
    return file.replace(/^\.\//, "");
  }
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (root && file.startsWith(prefix)) {
    return file.slice(prefix.length);
  }
  return RUNNER_CHECKOUT_RE.exec(file)?.[1] ?? null;
}

/** A Go package directory: the longest suffix of its import path that exists. */
function goPackageCandidates(pkg: string, file: string): string[] {
  const segments = pkg.split("/");
  return segments.map((_, i) => `${segments.slice(i).join("/")}/${file}`);
}

export function makeResolver(options: ResolverOptions): PathResolver {
  return (file, pkg) => {
    const relative = repoRelative(file, options.root);
    if (
      !relative ||
      relative.startsWith("../") ||
      relative.includes("node_modules/")
    ) {
      return null;
    }
    const candidates = [
      ...(pkg ? goPackageCandidates(pkg, relative) : []),
      relative,
      ...options.dirs.map((dir) => `${dir}/${relative}`),
    ];
    return candidates.find((candidate) => options.exists(candidate)) ?? null;
  };
}

const CD_RE =
  /\bcd\s+"?(?:\$GITHUB_WORKSPACE\/|\$\{GITHUB_WORKSPACE\}\/)?([\w.][\w./-]*)"?/g;

/** Repo directories the task script `cd`s into (to resolve relative paths). */
export function scriptDirs(script: string): string[] {
  return unique([...script.matchAll(CD_RE)].flatMap((match) => match[1] ?? []));
}
