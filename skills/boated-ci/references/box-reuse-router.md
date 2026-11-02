# When consolidation is not enough: box reuse

Consolidation gets you to ~1 start per run. If even that exceeds the plan
(many repos, many PRs, many small workflows you cannot merge), the next lever
is to make one machine start serve several jobs.

## Rule of thumb

```
ratio = jobs per day / starts per day included in the plan
```

- `ratio <= 1`: you do not need box reuse. Use the provider's native
  `runs-on:` and consolidate jobs.
- `ratio > 1`: every box must serve on average at least `ratio` jobs. Aim
  higher (x1.5) to absorb peaks, and check the hour and minute caps too: a
  router can also pace starts to stay under per-minute limits.

`audit-starts.ts` prints this ratio (its "router" verdict) when the peak day is
over the cap even at ~1 start per run.

## The design (from the credited article and repo)

Source: the article by @jackson_felty and the repository
`github.com/pnkfluffy/boat-router` (experimental, MIT; its README says it is
**not production-ready** and that resets can fail or need operator recovery).
Read both before building anything like it.

- **Webhook-driven scheduler**: a small service (in that repo, a Cloudflare
  Worker with a Durable Object holding admission and pool state) receives
  signed GitHub `workflow_job` webhooks, queues jobs and decides when each one
  gets a machine.
- **Reuse after a light reset**: when a job ends, the box is reset (workspace,
  temp, docker state, credentials) and handed the next queued job instead of
  being destroyed. Only with an explicit per-project policy and a successful
  reset; a failed reset means destroy.
- **Shared start ledger / pacing**: new starts are admitted against the
  account's limits (a token bucket per minute/hour/day shared by all
  projects), with fairness across projects.
- **Prefer existing capacity**: idle boxes first (the article also routes to
  local/owned machines first), new starts last.
- **Idle hold**: keep a reset box warm for a few minutes (the article used
  about 7) waiting for the next job, then let it stop.

## Risks to weigh

- **Isolation**: a reused box ran someone else's job. Light resets do not
  undo everything (kernel state, docker images, caches, background processes,
  leaked files outside the workspace). Never reuse across trust boundaries
  (fork PRs, different repos with different secrets). Prefer reuse only for
  jobs from the same repo and the same trust level.
- **Determinism**: "works on a warm box, fails on a fresh one" bugs.
- **Operations**: you now run a scheduler. If it is down, CI is down. Keep a
  variable-driven fallback (`runs-on` from `vars.*`) to the native runners.

## Order of preference

1. Fix waste: full reruns, cancelled-after-start jobs, aggregate jobs.
2. Consolidate to one heavy job per run (this skill).
3. Bigger plan, if the numbers justify it (sizing-and-cost.md).
4. Box reuse / router.
