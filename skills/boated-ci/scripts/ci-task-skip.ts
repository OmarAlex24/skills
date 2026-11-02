/**
 * Skip-on-rerun: when a pull-request run is rerun (`gh run rerun --failed`
 * reruns the whole heavy job, because it is ONE job), skip the background
 * tasks that already passed on the very same code. Only the failed tasks and
 * the foreground trunk (checkout, install, lint, build, unit tests) run again.
 *
 *   ci-task.ts plan
 *
 * A task "already passed" only if one of the `<job> / <task>` check runs on
 * the PR head commit:
 *   - was created by GitHub Actions (app id 15368, the job token's app),
 *   - has external_id exactly `<task>@<github.sha>` (the test merge commit:
 *     a rerun keeps it, a new push or a moved base branch changes it),
 *   - concluded `success`.
 * Only the publishing step of the workflow writes such checks, with the job
 * token. Fork PRs get a read-only token and cannot publish checks, so they
 * cannot seed a green check to make a task skip.
 *
 * Safety rails: only on `pull_request`; `CI_TASK_SKIP_PASSED=false` (repo
 * variable) turns it off; any API error skips nothing; the step itself never
 * fails (empty outputs == "false" == run everything).
 *
 * Tasks and shared resources come from a manifest (CI_TASKS_FILE, default
 * `.github/ci-tasks.json`):
 *
 *   { "tasks": [
 *       { "name": "e2e",      "enabledBy": "E2E_CHECKS" },
 *       { "name": "go-tests", "enabledBy": "GO_CHECKS", "uses": ["postgres", "go"] },
 *       { "name": "db-suite", "enabledBy": "DB_CHECKS", "uses": ["postgres"] } ] }
 *
 * Step outputs (`steps.<id>.outputs.<name>`), "true" or "false": one per task
 * and one per shared resource. A resource is "true" (its prep steps can be
 * skipped) only when at least one of its tasks was skipped and no other task
 * that uses it is enabled (env var `enabledBy` == "true") and will run.
 *
 * Each skipped task leaves `<task>.skipped.json` in the tasks dir so `wait`,
 * `publish` and task-metrics.ts show it as "skipped: passed in attempt N".
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  apiHeaders,
  checkName,
  externalId,
  type Fetch,
  parseRunMarker,
} from "./ci-task-checks";

/** GitHub Actions: the app the job's GITHUB_TOKEN publishes check runs as. */
export const GITHUB_ACTIONS_APP_ID = 15_368;
const SKIPPED_SUFFIX = ".skipped.json";
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface TaskSpec {
  /** Env var set to "true" by the router when the task should run; absent = always. */
  readonly enabledBy?: string | undefined;
  readonly name: string;
  /** Shared resources whose prep steps serve this task (postgres, go, browsers...). */
  readonly uses?: readonly string[] | undefined;
}

export interface TaskManifest {
  readonly tasks: readonly TaskSpec[];
}

/** Parse and validate the manifest; throws with a readable message. */
export function parseManifest(text: string): TaskManifest {
  const raw: unknown = JSON.parse(text);
  const tasks = (raw as { tasks?: unknown })?.tasks;
  if (!Array.isArray(tasks)) {
    throw new Error('manifest needs a "tasks" array');
  }
  const names = new Set<string>();
  const parsed = tasks.map((task: Partial<TaskSpec>) => {
    if (typeof task?.name !== "string" || !NAME_RE.test(task.name)) {
      throw new Error(`bad task name: ${JSON.stringify(task?.name)}`);
    }
    if (names.has(task.name)) {
      throw new Error(`duplicate task: ${task.name}`);
    }
    names.add(task.name);
    return {
      name: task.name,
      enabledBy: task.enabledBy,
      uses: Array.isArray(task.uses) ? task.uses.map(String) : [],
    };
  });
  for (const resource of parsed.flatMap((task) => task.uses)) {
    if (names.has(resource) || !NAME_RE.test(resource)) {
      throw new Error(`resource name clashes with a task or is invalid: ${resource}`);
    }
  }
  return { tasks: parsed };
}

/** What we read from a check run; the rest of the response is ignored. */
export interface CheckRunRecord {
  readonly app?: { readonly id?: number } | null;
  readonly conclusion?: string | null;
  readonly external_id?: string | null;
  readonly html_url?: string;
  readonly id?: number;
  readonly name?: string;
  readonly output?: { readonly summary?: string | null } | null;
}

export interface PassedTask {
  readonly attempt: number | null;
  readonly checkUrl: string;
  readonly runId: string | null;
  readonly task: string;
}

export interface SkippedMarker {
  readonly checkUrl: string;
  /** "passed in attempt 1": shown after "skipped: ". */
  readonly note: string;
  readonly task: string;
}

/** The newest matching green check of this task on this exact merge commit. */
export function findPassedRun(
  jobName: string,
  task: string,
  sha: string,
  runs: readonly CheckRunRecord[]
): PassedTask | null {
  const key = externalId(task, sha);
  const latest = runs
    .filter(
      (run) =>
        run.name === checkName(jobName, task) &&
        run.app?.id === GITHUB_ACTIONS_APP_ID &&
        run.external_id === key &&
        run.conclusion === "success"
    )
    .sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];
  if (!latest) {
    return null;
  }
  const marker = parseRunMarker(latest.output?.summary ?? "");
  return {
    task,
    runId: marker?.runId ?? null,
    attempt: marker?.attempt ?? null,
    checkUrl: latest.html_url ?? "",
  };
}

export function priorAttemptNote(passed: PassedTask, runId: string): string {
  if (passed.attempt === null) {
    return "passed in an earlier attempt";
  }
  if (passed.runId === null || passed.runId === runId) {
    return `passed in attempt ${passed.attempt}`;
  }
  return `passed in run ${passed.runId} (attempt ${passed.attempt})`;
}

/** null when checks should be consulted; otherwise why nothing is skipped. */
export function skipDisabledReason(env: NodeJS.ProcessEnv): string | null {
  if (env.GITHUB_EVENT_NAME !== "pull_request") {
    return `skipping only happens on pull_request, this is ${env.GITHUB_EVENT_NAME || "another event"}`;
  }
  if ((env.CI_TASK_SKIP_PASSED ?? "").trim().toLowerCase() === "false") {
    return "CI_TASK_SKIP_PASSED is false";
  }
  if (!(env.HEAD_SHA && env.GITHUB_SHA && env.GITHUB_REPOSITORY)) {
    return "HEAD_SHA, GITHUB_SHA or GITHUB_REPOSITORY is missing";
  }
  return null;
}

function enabled(task: TaskSpec, env: NodeJS.ProcessEnv): boolean {
  return task.enabledBy ? env[task.enabledBy] === "true" : true;
}

/** Step outputs: one per task and one per shared resource, "true" = skip. */
export function skipOutputs(
  manifest: TaskManifest,
  skipped: ReadonlySet<string>,
  env: NodeJS.ProcessEnv
): Record<string, "false" | "true"> {
  const outputs: Record<string, "false" | "true"> = {};
  for (const task of manifest.tasks) {
    outputs[task.name] = skipped.has(task.name) ? "true" : "false";
  }
  const resources = new Set(manifest.tasks.flatMap((task) => task.uses ?? []));
  for (const resource of resources) {
    const users = manifest.tasks.filter((task) =>
      (task.uses ?? []).includes(resource)
    );
    const someoneRuns = users.some(
      (task) => enabled(task, env) && !skipped.has(task.name)
    );
    const someoneSkipped = users.some((task) => skipped.has(task.name));
    outputs[resource] = !someoneRuns && someoneSkipped ? "true" : "false";
  }
  return outputs;
}

// --- API -------------------------------------------------------------------------

interface CheckRunsPage {
  readonly check_runs?: readonly CheckRunRecord[];
}

export interface FetchRunsOptions {
  readonly apiUrl: string;
  readonly fetch: Fetch;
  readonly headSha: string;
  readonly name: string;
  readonly repository: string;
  readonly token: string;
}

/** Check runs with this name on the commit; throws if the API fails. */
export async function fetchCheckRuns(
  options: FetchRunsOptions
): Promise<readonly CheckRunRecord[]> {
  // filter=all: the default (latest) returns only the newest per name.
  const query = new URLSearchParams({
    check_name: options.name,
    app_id: String(GITHUB_ACTIONS_APP_ID),
    filter: "all",
    per_page: "100",
  });
  const response = await options.fetch(
    `${options.apiUrl}/repos/${options.repository}/commits/${options.headSha}/check-runs?${query}`,
    { headers: apiHeaders(options.token) }
  );
  if (!response.ok) {
    throw new Error(
      `${options.name}: HTTP ${response.status} ${await response.text()}`.slice(0, 300)
    );
  }
  const page: CheckRunsPage = JSON.parse(await response.text());
  return page.check_runs ?? [];
}

// --- plan --------------------------------------------------------------------------

export function planSummary(
  passed: readonly PassedTask[],
  env: NodeJS.ProcessEnv,
  reason: string | null
): string {
  const title = "### Tasks that already passed on this code";
  if (reason !== null) {
    return `${title}\n\nNothing skipped: ${reason}.\n`;
  }
  const sha = (env.GITHUB_SHA ?? "").slice(0, 12);
  if (passed.length === 0) {
    return `${title}\n\nNo task passed before on merge commit \`${sha}\`: all run.\n`;
  }
  return [
    title,
    "",
    `Already green on merge commit \`${sha}\`: they do not run again and publish no new check; their green check stays on the commit.`,
    "",
    ...passed.map(
      (task) =>
        `- **${task.task}**: skipped, ${priorAttemptNote(task, env.GITHUB_RUN_ID ?? "")} ([check](${task.checkUrl}))`
    ),
    "",
    "To run everything again: push a new commit, or set the repository variable `CI_TASK_SKIP_PASSED=false` before rerunning.",
    "",
  ].join("\n");
}

export interface PlanOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly fetch: Fetch;
  readonly jobName: string;
  readonly manifest: TaskManifest;
  readonly print: (line: string) => void;
}

export interface PlanResult {
  readonly outputs: Record<string, "false" | "true">;
  readonly passed: readonly PassedTask[];
  readonly summary: string;
}

/** Decide what to skip; any API error skips nothing. */
export async function planSkips(options: PlanOptions): Promise<PlanResult> {
  const { env, manifest, jobName } = options;
  const reason = skipDisabledReason(env);
  let passed: PassedTask[] = [];
  if (reason === null) {
    try {
      const found = await Promise.all(
        manifest.tasks.map(async (task) =>
          findPassedRun(
            jobName,
            task.name,
            env.GITHUB_SHA ?? "",
            await fetchCheckRuns({
              apiUrl: env.GITHUB_API_URL || "https://api.github.com",
              fetch: options.fetch,
              headSha: env.HEAD_SHA ?? "",
              name: checkName(jobName, task.name),
              repository: env.GITHUB_REPOSITORY ?? "",
              token: env.GITHUB_TOKEN ?? "",
            })
          )
        )
      );
      passed = found.filter((task): task is PassedTask => task !== null);
    } catch (error) {
      options.print(
        `::warning::Could not read task checks; skipping nothing: ${String(error)}`
      );
      passed = [];
    }
  }
  const skipped = new Set(passed.map((task) => task.task));
  return {
    outputs: skipOutputs(manifest, skipped, env),
    passed,
    summary: planSummary(passed, env, reason),
  };
}

// --- Markers -----------------------------------------------------------------------

export function writeSkippedMarkers(
  dir: string,
  passed: readonly PassedTask[],
  runId: string
): void {
  mkdirSync(dir, { recursive: true });
  for (const task of passed) {
    const marker: SkippedMarker = {
      task: task.task,
      note: priorAttemptNote(task, runId),
      checkUrl: task.checkUrl,
    };
    writeFileSync(join(dir, `${task.task}${SKIPPED_SUFFIX}`), JSON.stringify(marker, null, 2));
  }
}

export function readSkippedMarker(dir: string, task: string): SkippedMarker | null {
  try {
    const marker: Partial<SkippedMarker> = JSON.parse(
      readFileSync(join(dir, `${task}${SKIPPED_SUFFIX}`), "utf8")
    );
    return marker.task && marker.note
      ? { task: marker.task, note: marker.note, checkUrl: marker.checkUrl ?? "" }
      : null;
  } catch {
    return null;
  }
}

export function readSkippedMarkers(dir: string): SkippedMarker[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(SKIPPED_SUFFIX))
    .sort()
    .flatMap((entry) => readSkippedMarker(dir, entry.slice(0, -SKIPPED_SUFFIX.length)) ?? []);
}

export function loadManifest(env: NodeJS.ProcessEnv): TaskManifest {
  const path = env.CI_TASKS_FILE || ".github/ci-tasks.json";
  return parseManifest(readFileSync(path, "utf8"));
}

/** `ci-task.ts plan`: outputs, summary and markers; never fails the step. */
export async function runPlan(
  env: NodeJS.ProcessEnv,
  dir: string,
  jobName: string
): Promise<number> {
  try {
    const result = await planSkips({
      env,
      fetch,
      jobName,
      manifest: loadManifest(env),
      print: (line) => console.log(line),
    });
    writeSkippedMarkers(dir, result.passed, env.GITHUB_RUN_ID ?? "");
    const lines = Object.entries(result.outputs).map(([name, value]) => `${name}=${value}`);
    if (env.GITHUB_OUTPUT) {
      appendFileSync(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
    }
    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(env.GITHUB_STEP_SUMMARY, result.summary);
    }
    process.stdout.write(`${result.summary}\n${lines.join("\n")}\n`);
  } catch (error) {
    console.log(`::warning::ci-task.ts plan failed; skipping nothing: ${String(error)}`);
  }
  return 0;
}
