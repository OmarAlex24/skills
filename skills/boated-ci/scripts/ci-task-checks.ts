/**
 * One check run `<job> / <task>` per background task of the heavy job, with
 * the trimmed failure in `output.text` and up to 50 annotations.
 *
 * The required check stays the heavy job itself (`<job>`); these per-task
 * checks only say which part failed and why, without opening a 100k-line log.
 *
 * `external_id` is `<task>@<github.sha>`. On a pull_request event github.sha
 * is the test merge commit (refs/pull/N/merge), which a rerun keeps and a new
 * push changes. `ci-task.ts plan` (ci-task-skip.ts) uses that exact key to
 * know, on a rerun, which tasks already passed on the same code.
 *
 * The summary ends with a machine-readable marker
 * `<!-- boated-ci run=<id> attempt=<n> -->` so `plan` can say where a
 * skipped task passed. Publishing never fails the job: the task's own `wait`
 * step already decided the job result.
 */
import { type CheckAnnotation, MAX_ANNOTATIONS } from "./ci-task-extract";

const MAX_SUMMARY_LENGTH = 65_535;
const API_VERSION = "2022-11-28";

export type TaskOutcome = "failed" | "not-started" | "passed" | "timeout";

/** What `wait` decided about a task, as stored in `<task>.verdict.json`. */
export interface TaskVerdict {
  readonly annotations: readonly CheckAnnotation[];
  /** Exit code of the task script; null if it did not finish or start. */
  readonly code: number | null;
  /** First meaningful lines of the script, without comments. */
  readonly command: readonly string[];
  /** "3 Bun tests"; empty if no extractor recognised the output. */
  readonly headline: string;
  readonly limit: number;
  readonly outcome: TaskOutcome;
  /** Seconds in the background, start to end. */
  readonly seconds: number | null;
  readonly task: string;
  /** Trimmed failure (markdown); empty when it passed. */
  readonly text: string;
  /** Seconds the `wait` step blocked. */
  readonly waited: number;
}

/** Where it ran: set by the publishing step, not by PR code. */
export interface CheckContext {
  readonly artifactName: string;
  /** `artifact-url` output of actions/upload-artifact; empty if upload failed. */
  readonly artifactUrl: string;
  readonly attempt: string;
  /** PR head commit (pull_request.head.sha): where the PR UI shows checks. */
  readonly headSha: string;
  /** Heavy job's name, used as the check-name prefix. */
  readonly jobName: string;
  /** Log URL of the heavy job, or of the run if the job was not found. */
  readonly jobUrl: string;
  readonly runId: string;
  /** github.sha: on a PR, the test merge commit. */
  readonly sha: string;
}

export interface TaskCheckRunPayload {
  readonly conclusion: "failure" | "success";
  readonly details_url: string;
  readonly external_id: string;
  readonly head_sha: string;
  readonly name: string;
  readonly output: {
    readonly annotations?: readonly CheckAnnotation[] | undefined;
    readonly summary: string;
    readonly text?: string | undefined;
    readonly title: string;
  };
  readonly status: "completed";
}

/** Never the bare job name: that one is the required check. */
export function checkName(jobName: string, task: string): string {
  return `${jobName} / ${task}`;
}

/** The key `plan` uses to recognise a task that already passed on this code. */
export function externalId(task: string, sha: string): string {
  return `${task}@${sha}`;
}

export function runMarker(runId: string, attempt: string): string {
  return `<!-- boated-ci run=${runId} attempt=${attempt} -->`;
}

const MARKER_RE = /<!-- boated-ci run=(\d+) attempt=(\d+) -->/;

export function parseRunMarker(
  summary: string
): { attempt: number; runId: string } | null {
  const match = MARKER_RE.exec(summary);
  return match ? { runId: match[1] ?? "", attempt: Number(match[2]) } : null;
}

export function checkTitle(verdict: TaskVerdict): string {
  switch (verdict.outcome) {
    case "passed":
      return `passed in ${verdict.seconds ?? 0} s`;
    case "timeout":
      return `did not finish within ${verdict.limit} s`;
    case "not-started":
      return "did not start: its start step failed";
    default:
      return verdict.headline
        ? `failed: ${verdict.headline}`
        : `failed with exit code ${verdict.code ?? "?"}`;
  }
}

function outcomeLine(verdict: TaskVerdict): string {
  const waited = `; the step that collected it waited ${verdict.waited} s`;
  switch (verdict.outcome) {
    case "passed":
      return `**${verdict.task}** passed in ${verdict.seconds ?? 0} s in the background${waited}.`;
    case "timeout":
      return `**${verdict.task}** did not finish within ${verdict.limit} s of starting.`;
    case "not-started":
      return `**${verdict.task}** did not start: its start step failed or did not run.`;
    default:
      return `**${verdict.task}** failed with exit code ${verdict.code ?? "?"} after ${verdict.seconds ?? 0} s${waited}.`;
  }
}

export function checkSummary(
  verdict: TaskVerdict,
  context: CheckContext
): string {
  const command =
    verdict.command.length > 0
      ? ["", "What it runs:", "", "```bash", ...verdict.command, "```"]
      : [];
  const rerun =
    verdict.outcome === "passed"
      ? []
      : [
          "",
          `Rerun only what failed: \`gh run rerun ${context.runId} --failed\` (one machine start; tasks that already passed on this code are skipped).`,
        ];
  const artifact = context.artifactUrl
    ? `[${context.artifactName}](${context.artifactUrl})`
    : `\`${context.artifactName}\` (in the run's artifacts)`;
  const text = [
    outcomeLine(verdict),
    ...command,
    ...rerun,
    "",
    `- Job log: ${context.jobUrl}`,
    `- Full task log: \`${verdict.task}.log\` in artifact ${artifact}`,
    "",
    runMarker(context.runId, context.attempt),
  ].join("\n");
  return text.slice(0, MAX_SUMMARY_LENGTH);
}

/** The check run for one task; annotations only when it failed. */
export function taskCheckRun(
  verdict: TaskVerdict,
  context: CheckContext
): TaskCheckRunPayload {
  const passed = verdict.outcome === "passed";
  return {
    name: checkName(context.jobName, verdict.task),
    head_sha: context.headSha,
    external_id: externalId(verdict.task, context.sha),
    status: "completed",
    conclusion: passed ? "success" : "failure",
    details_url: context.jobUrl,
    output: {
      title: checkTitle(verdict),
      summary: checkSummary(verdict, context),
      text: passed || !verdict.text ? undefined : verdict.text,
      annotations:
        passed || verdict.annotations.length === 0
          ? undefined
          : verdict.annotations.slice(0, MAX_ANNOTATIONS),
    },
  };
}

// --- GitHub API ------------------------------------------------------------------

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export function apiHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
  };
}

export interface PublishOptions {
  readonly apiUrl: string;
  readonly fetch: Fetch;
  readonly payloads: readonly TaskCheckRunPayload[];
  readonly print: (line: string) => void;
  readonly repository: string;
  readonly token: string;
}

/** POST one check run; null when GitHub accepted it, else why not. */
export async function publishCheckRun(
  options: Omit<PublishOptions, "payloads" | "print">,
  payload: TaskCheckRunPayload
): Promise<string | null> {
  try {
    const response = await options.fetch(
      `${options.apiUrl}/repos/${options.repository}/check-runs`,
      {
        method: "POST",
        headers: {
          ...apiHeaders(options.token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );
    if (response.ok) {
      return null;
    }
    return `GitHub answered ${response.status}: ${(await response.text()).slice(0, 300)}`;
  } catch (error) {
    return `GitHub did not answer: ${String(error)}`;
  }
}

/** Publish every check; an API error is a warning and never changes the result. */
export async function publishTaskChecks(
  options: PublishOptions
): Promise<number> {
  for (const payload of options.payloads) {
    const problem = await publishCheckRun(options, payload);
    options.print(
      problem === null
        ? `${payload.name}: ${payload.conclusion} · ${payload.output.title}`
        : `::warning::Check ${payload.name} (${payload.conclusion}) not published: ${problem}`
    );
  }
  return 0;
}

export interface JobUrlOptions {
  readonly apiUrl: string;
  readonly attempt: string;
  readonly fetch: Fetch;
  readonly jobName: string;
  readonly repository: string;
  readonly runId: string;
  readonly runUrl: string;
  readonly token: string;
}

interface JobsPage {
  readonly jobs?: readonly { html_url?: string; name?: string }[];
}

/** Link to the heavy job's log; the run URL if the API does not give it. */
export async function findJobUrl(options: JobUrlOptions): Promise<string> {
  try {
    const response = await options.fetch(
      `${options.apiUrl}/repos/${options.repository}/actions/runs/${options.runId}/attempts/${options.attempt}/jobs?per_page=100`,
      { headers: apiHeaders(options.token) }
    );
    if (!response.ok) {
      return options.runUrl;
    }
    const page: JobsPage = JSON.parse(await response.text());
    const job = page.jobs?.find((item) => item.name === options.jobName);
    return job?.html_url ?? options.runUrl;
  } catch {
    return options.runUrl;
  }
}
