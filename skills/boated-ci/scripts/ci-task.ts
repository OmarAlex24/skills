/**
 * Background tasks inside ONE GitHub Actions job, with per-task results.
 *
 * On runner providers that bill or cap per machine start, every job that gets
 * a runner costs a start. Instead of N parallel jobs, run N background tasks
 * inside one big job, and keep what parallel jobs gave you: a verdict per
 * task, a readable failure per task, and cheap reruns.
 *
 *   ci-task.ts start <task> <<'EOF' ... EOF   launch the script detached
 *   ci-task.ts wait <task> <seconds>          block until it ends; exit 0 only if it passed
 *   ci-task.ts plan                           (PR reruns) decide which tasks to skip
 *   ci-task.ts publish [--dry-run]            one check run `<job> / <task>` per task
 *   ci-task.ts mask                           stdin -> stdout with secret values masked
 *
 * `start` writes the script and launches it in its own session (like nohup),
 * without the step's stdin/stdout: the step ends at once and the process keeps
 * running through later steps (the runner kills it when the job ends). The
 * script inherits the step's env. GitHub's per-step command files are no use
 * to it, so its GITHUB_STEP_SUMMARY points at a private file that `wait`
 * appends to its own step summary; GITHUB_ENV/OUTPUT/PATH do nothing.
 *
 * The task's output never goes through the runner's log masking, so it is piped
 * through `ci-task.ts mask` before it touches disk: values of env vars whose
 * name looks secret (TOKEN, SECRET, PASSWORD, ..._KEY) are replaced by ***.
 * `wait` masks again with its own env. Secrets that only exist in some other
 * step's env are invisible to both: pass them to the start step.
 *
 * `wait` waits up to <seconds> counted from the task's start, prints the
 * trimmed failure first (ci-task-extract.ts) and the full log in a group, and
 * leaves `<task>.verdict.json` for `publish`.
 *
 * Files live in $RUNNER_TEMP/background-steps/<task>.{sh,log,start,end,exit,
 * summary,waited,verdict.json,skipped.json}. `.start`/`.end` are the task's
 * window that task-metrics.ts uses to slice the machine samples.
 *
 * Env: CHECK_JOB_NAME (check-name prefix; default GITHUB_JOB), CI_TASKS_FILE
 * (manifest for `plan`), ARTIFACT_NAME / ARTIFACT_URL (log artifact link),
 * HEAD_SHA (PR head commit), CI_TASK_MASK_NAMES (extra secret var names,
 * comma separated), CI_TASK_SKIP_PASSED=false (disable skip-on-rerun).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
  type CheckContext,
  findJobUrl,
  publishTaskChecks,
  type TaskOutcome,
  type TaskVerdict,
  taskCheckRun,
} from "./ci-task-checks";
import {
  type FailureExcerpt,
  failureExcerpt,
  makeResolver,
  scriptDirs,
} from "./ci-task-extract";
import {
  readSkippedMarker,
  readSkippedMarkers,
  runPlan,
  type SkippedMarker,
} from "./ci-task-skip";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const USAGE =
  "Usage: ci-task.ts start|wait <task> [seconds] | plan | publish [--dry-run] | mask";
const POLL_MILLIS = 1000;
const MAX_COMMAND_LINES = 12;
const FILE_SUFFIXES = [
  "sh",
  "log",
  "start",
  "end",
  "exit",
  "exit.tmp",
  "summary",
  "waited",
  "verdict.json",
  // A task that starts is no longer skipped.
  "skipped.json",
];

// $1 script, $2 file base, $3 bun binary, $4 this file. The exit code is
// written to a temp file and renamed, so `wait` never reads half of it.
const WRAPPER = `
if [ "\${CI_TASK_MASK:-true}" = "false" ]; then
  bash "$1" >"$2.log" 2>&1
  code=$?
else
  bash "$1" 2>&1 | "$3" "$4" mask >"$2.log"
  code=\${PIPESTATUS[0]}
fi
date +%s >"$2.end"
echo "$code" >"$2.exit.tmp" && mv "$2.exit.tmp" "$2.exit"
`;

export function tasksDir(env: NodeJS.ProcessEnv): string {
  return join(env.RUNNER_TEMP || "/tmp", "background-steps");
}

export function jobNameOf(env: NodeJS.ProcessEnv): string {
  return env.CHECK_JOB_NAME || env.GITHUB_JOB || "ci";
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function readEpoch(path: string): number | null {
  const text = readText(path).trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// --- Secret masking -------------------------------------------------------------

const SECRET_NAME_RE =
  /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|(?:^|_)KEY$|DSN|DATABASE_URL/i;

/** Values (>= 8 chars) of env vars that look secret, longest first. */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  const extra = new Set(
    (env.CI_TASK_MASK_NAMES ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
  );
  const values = Object.entries(env)
    .filter(
      ([name, value]) =>
        value &&
        value.length >= 8 &&
        (SECRET_NAME_RE.test(name) || extra.has(name))
    )
    .map(([, value]) => value as string);
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

export function maskWith(text: string, secrets: readonly string[]): string {
  let masked = text;
  for (const secret of secrets) {
    masked = masked.replaceAll(secret, "***");
  }
  return masked;
}

export function maskSecrets(text: string, env: NodeJS.ProcessEnv): string {
  return maskWith(text, secretValues(env));
}

async function maskStream(env: NodeJS.ProcessEnv): Promise<number> {
  const secrets = secretValues(env);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    process.stdout.write(`${maskWith(line, secrets)}\n`);
  }
  return 0;
}

// --- start ------------------------------------------------------------------------

export function startTask(
  name: string,
  script: string,
  env: NodeJS.ProcessEnv
): void {
  const dir = tasksDir(env);
  const base = join(dir, name);
  mkdirSync(dir, { recursive: true });
  for (const suffix of FILE_SUFFIXES) {
    rmSync(`${base}.${suffix}`, { force: true });
  }
  writeFileSync(`${base}.sh`, script);
  writeFileSync(`${base}.start`, `${nowSeconds()}\n`);
  const devNull = openSync("/dev/null", "w");
  const child = spawn(
    "bash",
    ["-c", WRAPPER, "ci-task", `${base}.sh`, base, process.execPath, import.meta.path],
    {
      detached: true,
      env: { ...env, GITHUB_STEP_SUMMARY: `${base}.summary` },
      stdio: ["ignore", devNull, devNull],
    }
  );
  child.unref();
  console.log(`Background task started: ${name} (log: ${base}.log)`);
}

// --- wait -------------------------------------------------------------------------

/** The script lines that say what runs, without comments or bookkeeping. */
export function commandSummary(script: string): string[] {
  const lines = script
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed !== "" &&
        !trimmed.startsWith("#") &&
        !trimmed.startsWith("set -") &&
        !trimmed.includes("GITHUB_STEP_SUMMARY")
      );
    })
    .slice(0, MAX_COMMAND_LINES + 1);
  const shown = lines.slice(0, MAX_COMMAND_LINES);
  return lines.length > MAX_COMMAND_LINES ? [...shown, "# …"] : shown;
}

export interface VerdictInput {
  readonly code: number | null;
  readonly env: NodeJS.ProcessEnv;
  readonly excerpt: FailureExcerpt | null;
  readonly limit: number;
  readonly name: string;
  readonly script: string;
  readonly seconds: number | null;
  readonly started: boolean;
  readonly waited: number;
}

function outcomeOf(input: VerdictInput): TaskOutcome {
  if (!input.started) {
    return "not-started";
  }
  if (input.code === null) {
    return "timeout";
  }
  return input.code === 0 ? "passed" : "failed";
}

export function buildVerdict(input: VerdictInput): TaskVerdict {
  const secrets = secretValues(input.env);
  const mask = (text: string) => maskWith(text, secrets);
  return {
    task: input.name,
    outcome: outcomeOf(input),
    code: input.code,
    limit: input.limit,
    seconds: input.seconds,
    waited: input.waited,
    command: commandSummary(input.script).map(mask),
    headline: input.excerpt?.headline ?? "",
    text: mask(input.excerpt?.text ?? ""),
    annotations: (input.excerpt?.annotations ?? []).map((annotation) => ({
      ...annotation,
      message: mask(annotation.message),
      title: annotation.title === undefined ? undefined : mask(annotation.title),
    })),
  };
}

function withNewline(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * What the wait step prints. The excerpt is wrapped in `::stop-commands::` so
 * its `::error` lines are not turned into duplicate annotations; the full log
 * is not, so the task's own workflow commands still reach the step.
 */
export function waitOutput(verdict: TaskVerdict, log: string, token: string): string {
  const name = verdict.task;
  if (verdict.outcome === "passed") {
    return `::group::${name}: log\n${withNewline(log)}::endgroup::\n`;
  }
  const excerpt = verdict.text
    ? [
        `${name}: trimmed failure (same as its check run)`,
        `::stop-commands::${token}`,
        `${withNewline(verdict.text)}::${token}::`,
        "",
      ].join("\n")
    : "";
  return `${excerpt}::group::${name}: full log\n${withNewline(log)}::endgroup::\n`;
}

function verdictLines(verdict: TaskVerdict): { lines: string[]; summary: string } {
  const name = verdict.task;
  if (verdict.outcome === "timeout") {
    return {
      lines: [`::error::${name} did not finish within ${verdict.limit} s of starting.`],
      summary: `- ${name}: unfinished after ${verdict.limit} s\n`,
    };
  }
  const took = `${name}: ${verdict.seconds} s in the background; this step waited ${verdict.waited} s.`;
  return {
    lines:
      verdict.outcome === "passed"
        ? [took]
        : [
            took,
            `::error::${name} failed (exit ${verdict.code}); trimmed failure above, full log in group "${name}: full log".`,
          ],
    summary: `- ${name}: ${verdict.seconds}s in the background, waited ${verdict.waited}s at the end\n`,
  };
}

async function waitForExit(exitPath: string, deadline: number): Promise<void> {
  while (!existsSync(exitPath) && nowSeconds() < deadline) {
    await Bun.sleep(POLL_MILLIS);
  }
}

function excerptFor(base: string, log: string, env: NodeJS.ProcessEnv): FailureExcerpt {
  const root = env.GITHUB_WORKSPACE || process.cwd();
  const resolve = makeResolver({
    root,
    dirs: scriptDirs(readText(`${base}.sh`)),
    exists: (path) => existsSync(join(root, path)),
  });
  return failureExcerpt(log, resolve);
}

function notStarted(name: string, limit: number, env: NodeJS.ProcessEnv): number {
  const dir = tasksDir(env);
  mkdirSync(dir, { recursive: true });
  const verdict = buildVerdict({
    name,
    env,
    limit,
    code: null,
    excerpt: null,
    script: "",
    seconds: null,
    started: false,
    waited: 0,
  });
  writeFileSync(join(dir, `${name}.verdict.json`), JSON.stringify(verdict, null, 2));
  console.log(`::error::${name} did not start: its start step failed or did not run.`);
  return 1;
}

/** Belt and braces: the workflow should already skip this wait step. */
function skippedTask(marker: SkippedMarker, env: NodeJS.ProcessEnv): number {
  const line = `${marker.task}: skipped, ${marker.note} (${marker.checkUrl}).`;
  console.log(line);
  appendFileSync(env.GITHUB_STEP_SUMMARY || "/dev/null", `- ${line}\n`);
  return 0;
}

export async function waitTask(
  name: string,
  limit: number,
  env: NodeJS.ProcessEnv
): Promise<number> {
  const base = join(tasksDir(env), name);
  const started = readEpoch(`${base}.start`);
  const skipped = readSkippedMarker(tasksDir(env), name);
  if (started === null && skipped !== null) {
    return skippedTask(skipped, env);
  }
  if (started === null) {
    return notStarted(name, limit, env);
  }
  const waitingFrom = Date.now();
  await waitForExit(`${base}.exit`, started + limit);
  const waited = Math.round((Date.now() - waitingFrom) / 1000);
  writeFileSync(`${base}.waited`, `${waited}\n`);

  const exitText = readText(`${base}.exit`).trim();
  const code = exitText === "" ? null : Number(exitText);
  const end = readEpoch(`${base}.end`);
  // Mask again with this step's env and store the masked copy: it is the file
  // that gets uploaded as an artifact.
  const log = maskSecrets(readText(`${base}.log`), env);
  writeFileSync(`${base}.log`, log);
  const verdict = buildVerdict({
    name,
    env,
    limit,
    code,
    waited,
    started: true,
    script: readText(`${base}.sh`),
    seconds: code === null || end === null ? null : end - started,
    excerpt: code === 0 ? null : excerptFor(base, log, env),
  });
  writeFileSync(`${base}.verdict.json`, JSON.stringify(verdict, null, 2));

  process.stdout.write(waitOutput(verdict, log, randomUUID()));
  const summaryPath = env.GITHUB_STEP_SUMMARY || "/dev/null";
  appendFileSync(summaryPath, readText(`${base}.summary`));
  const messages = verdictLines(verdict);
  appendFileSync(summaryPath, messages.summary);
  for (const line of messages.lines) {
    console.log(line);
  }
  return verdict.outcome === "passed" ? 0 : 1;
}

// --- publish ----------------------------------------------------------------------

export function readVerdicts(dir: string): TaskVerdict[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((file) => file.endsWith(".verdict.json"))
    .sort()
    .flatMap((file) => {
      try {
        return [JSON.parse(readText(join(dir, file))) as TaskVerdict];
      } catch {
        console.log(`::warning::Unreadable verdict: ${file}`);
        return [];
      }
    });
}

async function checkContext(env: NodeJS.ProcessEnv, dryRun: boolean): Promise<CheckContext> {
  const repository = env.GITHUB_REPOSITORY ?? "";
  const runId = env.GITHUB_RUN_ID ?? "";
  const attempt = env.GITHUB_RUN_ATTEMPT || "1";
  const jobName = jobNameOf(env);
  const runUrl = `${env.GITHUB_SERVER_URL || "https://github.com"}/${repository}/actions/runs/${runId}`;
  const jobUrl = dryRun
    ? runUrl
    : await findJobUrl({
        apiUrl: env.GITHUB_API_URL || "https://api.github.com",
        attempt,
        fetch,
        jobName,
        repository,
        runId,
        runUrl,
        token: env.GITHUB_TOKEN ?? "",
      });
  return {
    runId,
    attempt,
    jobName,
    jobUrl,
    headSha: env.HEAD_SHA || env.GITHUB_SHA || "",
    sha: env.GITHUB_SHA ?? "",
    artifactName: env.ARTIFACT_NAME || `${jobName}-task-logs-${attempt}`,
    artifactUrl: env.ARTIFACT_URL ?? "",
  };
}

export async function publishVerdicts(env: NodeJS.ProcessEnv, dryRun: boolean): Promise<number> {
  try {
    const dir = tasksDir(env);
    for (const marker of readSkippedMarkers(dir)) {
      console.log(`${marker.task}: skipped · ${marker.note}; its earlier check stays (${marker.checkUrl})`);
    }
    const context = await checkContext(env, dryRun);
    const payloads = readVerdicts(dir).map((verdict) => taskCheckRun(verdict, context));
    if (dryRun) {
      console.log(JSON.stringify(payloads, null, 2));
      return 0;
    }
    if (payloads.length === 0) {
      console.log("No background task ran: no checks to publish.");
      return 0;
    }
    return await publishTaskChecks({
      apiUrl: env.GITHUB_API_URL || "https://api.github.com",
      fetch,
      payloads,
      print: (line) => console.log(line),
      repository: env.GITHUB_REPOSITORY ?? "",
      token: env.GITHUB_TOKEN ?? "",
    });
  } catch (error) {
    console.log(`::warning::Task checks not published: ${String(error)}`);
    return 0;
  }
}

// --- CLI --------------------------------------------------------------------------

export async function main(args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [action = "", name = "", seconds = ""] = args;
  if (action === "mask") {
    return maskStream(env);
  }
  if (action === "plan") {
    return runPlan(env, tasksDir(env), jobNameOf(env));
  }
  if (action === "publish") {
    return publishVerdicts(env, name === "--dry-run");
  }
  if (!NAME_RE.test(name) || (action !== "start" && action !== "wait")) {
    console.error(`::error::${USAGE}`);
    return 2;
  }
  if (action === "start") {
    startTask(name, await Bun.stdin.text(), env);
    return 0;
  }
  if (!/^\d+$/.test(seconds)) {
    console.error(`::error::ci-task.ts wait ${name}: missing <seconds>`);
    return 2;
  }
  return waitTask(name, Number(seconds), env);
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), process.env));
}
