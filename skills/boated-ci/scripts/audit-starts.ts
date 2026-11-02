#!/usr/bin/env bun
/**
 * Audit how many runner MACHINE STARTS a repository's GitHub Actions use, and
 * compare them with a per-start plan (per day / hour / minute caps).
 *
 *   bun audit-starts.ts --repo owner/name [--days 2] [--plan 100]
 *       [--since 2026-10-30T00:00:00Z] [--until ...]
 *       [--cap-day 840 --cap-hour 210 --cap-minute 30]
 *       [--label 'boat'] [--by created|started] [--top 15] [--json]
 *
 * Read-only. Token: GITHUB_TOKEN, GH_TOKEN or `gh auth token`.
 *
 * What counts as a start (per job from /actions/runs/<id>/jobs?filter=all):
 *   - started:  the job got a runner (runner_id or runner_name set). 1 start.
 *   - queued-no-runner: has runner labels, not skipped, never got a runner
 *     (usually cancelled while queued). Some providers bill these too
 *     (they started provisioning on the `queued` webhook): reported apart
 *     and added to the "upper bound".
 *   - free: skipped by `if:` (never queued), or no labels at all. The jobs
 *     API also lists check runs created through the Checks API (for example
 *     `<job> / <task>` per-task checks) as "jobs" with no labels and no
 *     runner: they cost nothing and must not be counted.
 *
 * Jobs are bucketed by `created_at` (when the job was queued, which is when a
 * per-start provider begins provisioning) unless --by started.
 *
 * Caveat: runs are listed by creation date, so a rerun today of a run created
 * before the window is missed. Widen --since by a day if reruns matter.
 */

export interface JobRecord {
  readonly conclusion: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly event: string;
  readonly labels: readonly string[];
  readonly name: string;
  readonly runAttempt: number;
  readonly runId: number;
  readonly runnerId: number | null;
  readonly runnerName: string | null;
  readonly startedAt: string | null;
  readonly workflow: string;
}

export type JobClass = "free" | "queued-no-runner" | "started";

export interface Caps {
  readonly day: number;
  readonly hour: number;
  readonly hoursIncluded?: number | undefined;
  readonly minute: number;
}

/** Boat plans as published on 2026-11-01; verify current pricing before relying on them. */
export const PLANS: Record<string, Caps> = {
  "20": { minute: 12, hour: 60, day: 200, hoursIncluded: 555 },
  "100": { minute: 30, hour: 210, day: 840, hoursIncluded: 2777 },
  "500": { minute: 65, hour: 420, day: 1680, hoursIncluded: 13_888 },
  "2000": { minute: 90, hour: 600, day: 2400, hoursIncluded: 55_555 },
};

export function classifyJob(job: JobRecord): JobClass {
  if (job.runnerId !== null || (job.runnerName ?? "") !== "") {
    return "started";
  }
  if (job.labels.length === 0 || job.conclusion === "skipped") {
    return "free";
  }
  return "queued-no-runner";
}

export interface Peak {
  readonly at: string;
  readonly count: number;
}

export interface DayRow {
  readonly day: string;
  readonly peakHour: Peak;
  readonly peakMinute: Peak;
  readonly queuedNoRunner: number;
  readonly runs: number;
  readonly starts: number;
}

export interface NameRow {
  readonly avgMinutes: number;
  readonly cancelledAfterStart: number;
  readonly name: string;
  readonly starts: number;
}

export interface Summary {
  readonly byDay: readonly DayRow[];
  readonly byEvent: readonly { event: string; runs: number; starts: number }[];
  readonly byJob: readonly NameRow[];
  readonly byLabel: readonly { hours: number; label: string; starts: number }[];
  readonly cancelledAfterStart: number;
  readonly peakDay: DayRow | null;
  readonly peakHour: Peak;
  readonly peakMinute: Peak;
  readonly queuedNoRunner: number;
  readonly rerunStarts: number;
  readonly runsWithStarts: number;
  readonly starts: number;
}

function stampOf(job: JobRecord, by: "created" | "started"): string {
  return (by === "started" ? job.startedAt : null) ?? job.createdAt;
}

function minutesBetween(from: string | null, to: string | null): number {
  if (!(from && to)) {
    return 0;
  }
  return Math.max(0, (Date.parse(to) - Date.parse(from)) / 60_000);
}

function peakOf(counts: Map<string, number>): Peak {
  let best: Peak = { at: "", count: 0 };
  for (const [at, count] of counts) {
    if (count > best.count) {
      best = { at, count };
    }
  }
  return best;
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

/** Pure: everything the report prints, from job records. */
export function summarize(
  jobs: readonly JobRecord[],
  by: "created" | "started" = "created"
): Summary {
  const counted = jobs.filter((job) => classifyJob(job) !== "free");
  const started = counted.filter((job) => classifyJob(job) === "started");
  const hours = new Map<string, number>();
  const minutes = new Map<string, number>();
  const days = new Map<string, { queued: number; runs: Set<number>; starts: number }>();
  for (const job of counted) {
    const stamp = stampOf(job, by);
    const day = stamp.slice(0, 10);
    const entry = days.get(day) ?? { queued: 0, runs: new Set(), starts: 0 };
    if (classifyJob(job) === "started") {
      entry.starts += 1;
      entry.runs.add(job.runId);
      bump(hours, stamp.slice(0, 13));
      bump(minutes, stamp.slice(0, 16));
    } else {
      entry.queued += 1;
    }
    days.set(day, entry);
  }
  const byDay = [...days.entries()].sort().map(([day, entry]) => {
    const inDay = (map: Map<string, number>) =>
      new Map([...map].filter(([key]) => key.startsWith(day)));
    return {
      day,
      starts: entry.starts,
      queuedNoRunner: entry.queued,
      runs: entry.runs.size,
      peakHour: peakOf(inDay(hours)),
      peakMinute: peakOf(inDay(minutes)),
    };
  });
  const names = new Map<string, { cancelled: number; minutes: number; starts: number }>();
  const labels = new Map<string, { hours: number; starts: number }>();
  const events = new Map<string, { runs: Set<number>; starts: number }>();
  for (const job of started) {
    const ran = minutesBetween(job.startedAt, job.completedAt);
    const name = names.get(job.name) ?? { cancelled: 0, minutes: 0, starts: 0 };
    name.starts += 1;
    name.minutes += ran;
    name.cancelled += job.conclusion === "cancelled" ? 1 : 0;
    names.set(job.name, name);
    const labelKey = job.labels.join(",");
    const label = labels.get(labelKey) ?? { hours: 0, starts: 0 };
    label.starts += 1;
    label.hours += ran / 60;
    labels.set(labelKey, label);
    const event = events.get(job.event) ?? { runs: new Set(), starts: 0 };
    event.starts += 1;
    event.runs.add(job.runId);
    events.set(job.event, event);
  }
  const peakDay = byDay.reduce<DayRow | null>(
    (best, day) => (best === null || day.starts > best.starts ? day : best),
    null
  );
  return {
    starts: started.length,
    queuedNoRunner: counted.length - started.length,
    runsWithStarts: new Set(started.map((job) => job.runId)).size,
    rerunStarts: started.filter((job) => job.runAttempt > 1).length,
    cancelledAfterStart: started.filter((job) => job.conclusion === "cancelled").length,
    peakHour: peakOf(hours),
    peakMinute: peakOf(minutes),
    peakDay,
    byDay,
    byJob: [...names.entries()]
      .map(([name, value]) => ({
        name,
        starts: value.starts,
        cancelledAfterStart: value.cancelled,
        avgMinutes: value.starts > 0 ? value.minutes / value.starts : 0,
      }))
      .sort((a, b) => b.starts - a.starts),
    byLabel: [...labels.entries()]
      .map(([label, value]) => ({ label: label || "(none)", ...value }))
      .sort((a, b) => b.starts - a.starts),
    byEvent: [...events.entries()]
      .map(([event, value]) => ({ event, runs: value.runs.size, starts: value.starts }))
      .sort((a, b) => b.starts - a.starts),
  };
}

export interface Verdict {
  readonly level: "fits" | "over" | "router" | "tight";
  readonly lines: readonly string[];
  /** Highest of day/hour/minute utilisation (1 = at the cap). */
  readonly utilisation: number;
}

/** Pure: the decision tree of SKILL.md applied to the numbers. */
export function recommend(summary: Summary, caps: Caps): Verdict {
  const day = (summary.peakDay?.starts ?? 0) / caps.day;
  const hour = summary.peakHour.count / caps.hour;
  const minute = summary.peakMinute.count / caps.minute;
  const utilisation = Math.max(day, hour, minute);
  const perRun = summary.runsWithStarts > 0 ? summary.starts / summary.runsWithStarts : 0;
  const pct = (value: number) => `${Math.round(value * 100)} %`;
  const lines = [
    `Peak day ${pct(day)} of ${caps.day}/day, peak hour ${pct(hour)} of ${caps.hour}/h, peak minute ${pct(minute)} of ${caps.minute}/min.`,
    `Average ${perRun.toFixed(2)} starts per run that started anything.`,
  ];
  const shortJobs = summary.byJob.filter((job) => job.avgMinutes < 3).map((job) => job.name);
  if (summary.cancelledAfterStart > 0) {
    lines.push(
      `${summary.cancelledAfterStart} starts were cancelled after getting a machine (already paid): review concurrency cancel-in-progress on push/main.`
    );
  }
  if (summary.rerunStarts > 0) {
    lines.push(
      `${summary.rerunStarts} starts came from reruns (attempt > 1): use \`gh run rerun <id> --failed\`, never a full rerun.`
    );
  }
  if (utilisation <= 0.5) {
    return { level: "fits", utilisation, lines: [...lines, "FITS with headroom: do not restructure for starts. Fix wasteful reruns/cancels only."] };
  }
  if (utilisation <= 1) {
    return {
      level: "tight",
      utilisation,
      lines: [
        ...lines,
        `TIGHT: consolidate the cheapest jobs first${shortJobs.length ? ` (short jobs: ${shortJobs.slice(0, 8).join(", ")})` : ""}.`,
      ],
    };
  }
  const projected = (summary.peakDay?.runs ?? 0) / caps.day;
  if (perRun > 1.3 && projected <= 1) {
    return {
      level: "over",
      utilisation,
      lines: [
        ...lines,
        `OVER the cap. Consolidate toward ~1 start per run: at 1 start/run the peak day would be ~${summary.peakDay?.runs ?? 0} starts (${pct(projected)} of the day cap).`,
        ...(minute > 1 && day <= 1 ? ["Minute bursts come from fan-out (matrix / many parallel jobs per run): consolidating them fixes the burst."] : []),
      ],
    };
  }
  const ratio = Math.max(day, hour, minute);
  return {
    level: "router",
    utilisation,
    lines: [
      ...lines,
      `OVER the cap even at ~1 start per run: reuse boxes (router/pool, see references/box-reuse-router.md). Target jobs per box >= ${ratio.toFixed(1)}.`,
    ],
  };
}

// --- Rendering -----------------------------------------------------------------------

function table(header: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  const line = (cells: readonly (string | number)[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

export function renderReport(
  summary: Summary,
  caps: Caps,
  meta: { repo: string; since: string; until: string; by: string; runs: number; top: number }
): string {
  const verdict = recommend(summary, caps);
  const hours = summary.byLabel.reduce((sum, row) => sum + row.hours, 0);
  return [
    `# Machine starts: ${meta.repo}`,
    "",
    `Window ${meta.since} → ${meta.until} (UTC, bucketed by job ${meta.by}_at). ${meta.runs} workflow runs listed.`,
    `Starts (got a runner): **${summary.starts}**; queued without runner: ${summary.queuedNoRunner} (upper bound ${summary.starts + summary.queuedNoRunner}).`,
    `Peak hour ${summary.peakHour.count} (${summary.peakHour.at}Z), peak minute ${summary.peakMinute.count} (${summary.peakMinute.at}Z). Job time ${hours.toFixed(1)} h (before size multipliers and boot overhead).`,
    "",
    "## Per day (first/last day may be partial)",
    "",
    table(
      ["Day", "Starts", "Queued no runner", "Runs", "Peak hour", "Peak minute"],
      summary.byDay.map((d) => [d.day, d.starts, d.queuedNoRunner, d.runs, `${d.peakHour.count} @ ${d.peakHour.at.slice(11)}h`, `${d.peakMinute.count} @ ${d.peakMinute.at.slice(11)}`])
    ),
    "",
    "## Per event",
    "",
    table(["Event", "Runs", "Starts", "Starts/run"], summary.byEvent.map((e) => [e.event, e.runs, e.starts, (e.starts / Math.max(1, e.runs)).toFixed(2)])),
    "",
    `## Per job name (top ${meta.top})`,
    "",
    table(
      ["Job", "Starts", "% of starts", "Avg min", "Cancelled after start"],
      summary.byJob.slice(0, meta.top).map((j) => [j.name, j.starts, `${Math.round((j.starts / Math.max(1, summary.starts)) * 100)} %`, j.avgMinutes.toFixed(1), j.cancelledAfterStart])
    ),
    "",
    "## Per runner label",
    "",
    table(["Labels", "Starts", "Job hours"], summary.byLabel.map((l) => [l.label, l.starts, l.hours.toFixed(1)])),
    "",
    `## Against the plan (${caps.day}/day, ${caps.hour}/h, ${caps.minute}/min${caps.hoursIncluded ? `, ${caps.hoursIncluded} h included` : ""})`,
    "",
    ...verdict.lines.map((line) => `- ${line}`),
    "",
  ].join("\n");
}

// --- Fetching (CLI only) ---------------------------------------------------------------

interface Args {
  by: "created" | "started";
  caps: Caps;
  json: boolean;
  label: RegExp | null;
  repo: string;
  since: Date;
  top: number;
  until: Date;
}

export function parseArgs(argv: readonly string[], now = new Date()): Args {
  const get = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const repo = get("--repo") ?? process.env.GITHUB_REPOSITORY ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error("--repo owner/name is required");
  }
  const plan = PLANS[get("--plan") ?? "100"];
  if (!plan) {
    throw new Error(`--plan must be one of ${Object.keys(PLANS).join(", ")}`);
  }
  const num = (flag: string, fallback: number) => {
    const value = get(flag);
    return value === undefined ? fallback : Number(value);
  };
  const until = get("--until") ? new Date(get("--until") as string) : now;
  const since = get("--since")
    ? new Date(get("--since") as string)
    : new Date(until.getTime() - num("--days", 2) * 86_400_000);
  const label = get("--label");
  return {
    repo,
    since,
    until,
    by: get("--by") === "started" ? "started" : "created",
    caps: {
      day: num("--cap-day", plan.day),
      hour: num("--cap-hour", plan.hour),
      minute: num("--cap-minute", plan.minute),
      hoursIncluded: plan.hoursIncluded,
    },
    label: label ? new RegExp(label) : null,
    top: num("--top", 15),
    json: argv.includes("--json"),
  };
}

function token(): string {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) {
    return fromEnv;
  }
  const result = Bun.spawnSync(["gh", "auth", "token"]);
  const text = result.stdout.toString().trim();
  if (!text) {
    throw new Error("no token: set GITHUB_TOKEN or log in with `gh auth login`");
  }
  return text;
}

async function api<T>(path: string, auth: string): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${auth}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (response.ok) {
      return (await response.json()) as T;
    }
    if (attempt >= 3 || ![403, 429, 500, 502, 503].includes(response.status)) {
      throw new Error(`GET ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
    await Bun.sleep(2000 * attempt);
  }
}

async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

interface ApiRun {
  event: string;
  id: number;
  name: string;
}

/** Runs created in [since, until], split per day (and per hour if a day has > 1000). */
async function listRuns(repo: string, since: Date, until: Date, auth: string): Promise<ApiRun[]> {
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const windows: [Date, Date][] = [];
  for (let t = since.getTime(); t < until.getTime(); t += 86_400_000) {
    windows.push([new Date(t), new Date(Math.min(t + 86_400_000 - 1000, until.getTime()))]);
  }
  const runs: ApiRun[] = [];
  const fetchWindow = async (from: Date, to: Date): Promise<void> => {
    const base = `/repos/${repo}/actions/runs?per_page=100&created=${iso(from)}..${iso(to)}`;
    const first = await api<{ total_count: number; workflow_runs: ApiRun[] }>(`${base}&page=1`, auth);
    if (first.total_count > 1000 && to.getTime() - from.getTime() > 3_600_000) {
      for (let t = from.getTime(); t < to.getTime(); t += 3_600_000) {
        await fetchWindow(new Date(t), new Date(Math.min(t + 3_599_000, to.getTime())));
      }
      return;
    }
    runs.push(...first.workflow_runs);
    const pages = Math.min(10, Math.ceil(first.total_count / 100));
    for (let page = 2; page <= pages; page += 1) {
      runs.push(...(await api<{ workflow_runs: ApiRun[] }>(`${base}&page=${page}`, auth)).workflow_runs);
    }
  };
  for (const [from, to] of windows) {
    await fetchWindow(from, to);
  }
  return [...new Map(runs.map((run) => [run.id, run])).values()];
}

interface ApiJob {
  completed_at: string | null;
  conclusion: string | null;
  created_at: string;
  labels: string[];
  name: string;
  run_attempt?: number;
  runner_id: number | null;
  runner_name: string | null;
  started_at: string | null;
}

async function listJobs(repo: string, run: ApiRun, auth: string): Promise<JobRecord[]> {
  const jobs: ApiJob[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await api<{ jobs: ApiJob[]; total_count: number }>(
      `/repos/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${page}`,
      auth
    );
    jobs.push(...result.jobs);
    if (jobs.length >= result.total_count || result.jobs.length === 0) {
      break;
    }
  }
  return jobs.map((job) => ({
    name: job.name,
    labels: job.labels ?? [],
    conclusion: job.conclusion,
    createdAt: job.created_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    runnerId: job.runner_id ?? null,
    runnerName: job.runner_name ?? null,
    runAttempt: job.run_attempt ?? 1,
    runId: run.id,
    event: run.event,
    workflow: run.name,
  }));
}

async function cli(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const auth = token();
  const runs = await listRuns(args.repo, args.since, args.until, auth);
  const jobs = (await pool(runs, 8, (run) => listJobs(args.repo, run, auth))).flat();
  const inWindow = jobs.filter((job) => {
    const at = Date.parse((args.by === "started" ? job.startedAt : null) ?? job.createdAt);
    const labelled = args.label === null || job.labels.some((label) => args.label?.test(label));
    return at >= args.since.getTime() && at <= args.until.getTime() && labelled;
  });
  const summary = summarize(inWindow, args.by);
  if (args.json) {
    console.log(JSON.stringify({ summary, verdict: recommend(summary, args.caps) }, null, 2));
    return 0;
  }
  console.log(
    renderReport(summary, args.caps, {
      repo: args.repo,
      since: args.since.toISOString(),
      until: args.until.toISOString(),
      by: args.by,
      runs: runs.length,
      top: args.top,
    })
  );
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await cli());
  } catch (error) {
    console.error(`audit-starts: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
