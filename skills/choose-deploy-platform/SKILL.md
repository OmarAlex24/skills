---
name: choose-deploy-platform
description: "Audit a project and choose honestly between managed PaaS platforms (Vercel, Cloudflare, Netlify, Railway, Render, Fly.io, Cloud Run) and self-hosted VPS panels (Dokploy, Coolify). Use whenever the user asks for Vercel alternatives, wonders whether to migrate to Coolify or Dokploy on a VPS, wants to evaluate hosting tradeoffs and high availability (HA), or needs a Day-2 ops readiness checklist for self-hosting."
license: MIT
compatibility: "Works with any web or backend repository. Read-only inspection by default; no cloud credentials required. Compatible with Claude Code, Codex, Cursor, OpenCode, and Antigravity."
metadata:
  author: Omar Espinosa
  version: "0.1.0"
  repo: https://github.com/OmarAlex24/skills/tree/main/skills/choose-deploy-platform
  install: npx skills add OmarAlex24/skills --skill choose-deploy-platform
  agents: claude-code, codex, cursor, opencode, antigravity
  tags: deploy, vercel, dokploy, coolify, vps, paas, devops, cloud
  date: "2026-11-26"
  video: "016-dokploy-coolify-vs-vercel"
  description_es: "Audita tu proyecto y elige con honestidad entre plataformas administradas (Cloudflare, Netlify, Railway, Render, Fly.io, Cloud Run) o un VPS con Dokploy/Coolify. Deja claro qué responsabilidades asumes en un solo VPS y genera un checklist de operación Día 2 si decides auto-hostear."
  summary_es: "Matriz honesta para elegir entre PaaS administrado vs VPS con Dokploy/Coolify + checklist de operación Día 2."
---

# Choose Your Deploy Platform (Managed PaaS vs VPS Panels)

Help developers pick the right hosting layer for their actual app and operational appetite — without confusing a **VPS deployment panel** (Dokploy, Coolify) with a **managed PaaS** (Vercel, Cloudflare, Netlify, Railway, Render, Fly.io, Cloud Run).

Dokploy and Coolify are great open-source panels for managing containers on your own server. They are **not** drop-in equivalents to Vercel: on a single VPS, you rent, patch, back up, monitor, and recover the server — and if that single node dies, your app **and** your deployment panel go down together.

> **Language rule (mandatory):** Always match the language the user is speaking in (for example, reply, interview, and write checklists in Spanish if the user writes in Spanish). Keep tool/provider names and technical terms (`VPS`, `PaaS`, `HA`, `S3`, `TLS`) as-is.

---

## Step 1: Inspect the Repo First (If Inside a Workspace)

Before asking questions, inspect the current project (read-only) to detect its shape:
- Framework & runtime (`package.json`, `Dockerfile`, `astro.config.*`, `next.config.*`, `pyproject.toml`, `go.mod`, etc.)
- Workload type: static site / SSR frontend / serverless functions / long-running backend / WebSockets / background workers / cron jobs
- Stateful dependencies: Postgres, Redis, file uploads, queues

---

## Step 2: Ask 4 Quick Operational Questions

Skip any question already answered by the user or repo:

1. **Downtime tolerance:** Is this a side project/internal tool where a 30-minute outage is fine, or a production app with paying users / SLA?
2. **Who maintains the server?** Do you want zero OS/Docker maintenance, or are you comfortable owning Linux patches, backups, and incident recovery at 2 AM?
3. **Primary driver:** Are you trying to escape serverless limits/pricing spikes, reduce a fixed monthly bill, or simplify deploys?
4. **Data & replicas:** Do you need managed Postgres/backups and multi-replica failover (`≥ 2` instances)?

---

## Step 3: Compare Apples to Apples

Never compare a single unmanaged VPS directly to a managed multi-node PaaS without stating the responsibility shift.

### True Managed Alternatives (Provider owns the servers)
- **Frontend, SSR & Edge Functions:** **Cloudflare Pages/Workers**, **Netlify** (plus Vercel itself).
- **Containers, Backends, Workers & Full-Stack:** **Railway**, **Render**, **Fly.io**, **Google Cloud Run**.
- **HA caveat (mandatory):** Even on a managed PaaS, automatic failover requires **2 or more replicas** (and a plan that supports it). Running 1 single container instance still has restart downtime.

### Self-Hosted Panels on Your Own VPS
- **Dokploy / Coolify** on Hetzner, DigitalOcean, Linode, etc.
- **Best fit when:** You want predictable flat pricing, full Docker/network control, side projects, staging environments, or you already have real Linux/ops discipline.
- **Hidden trap:** On a single VPS, **one node = single point of failure (SPOF)**. You own OS kernel updates, Docker daemon health, disk fills, off-host backups, TLS renewals, and monitoring.

---

## Step 4: Output Tailored Recommendation + Checklist

Produce two concrete sections:

### A. Recommendation Matrix for This Project
Pick **1 primary path** and **1 runner-up** tailored to the detected stack, clearly listing:
- Why it fits this repo's architecture
- What the provider manages vs what the developer manages
- Exact replica / database setup needed if HA matters

### B. If Choosing Self-Hosted VPS (Dokploy / Coolify): Day-2 Ops Readiness Checklist
Never shame the choice — if the user wants a VPS, equip them to run it safely:
- [ ] **Off-host automated backups:** Database dumps + volumes pushed to external S3-compatible storage (never only on the same VPS disk)
- [ ] **Restore drill:** Verified restore command tested on a clean instance before launch
- [ ] **OS & Docker patching:** Unattended security updates + scheduled reboot window
- [ ] **Disk & memory alerts:** External monitoring (uptime + disk >80% + RAM/OOM alerts) hosted *outside* the VPS
- [ ] **Secrets & firewall:** UFW/security group locked down (`80/443` + restricted SSH/Tailscale), secrets not committed in git
- [ ] **SPOF recovery plan:** Documented steps (or IaC/snapshot) to rebuild on a fresh VPS if the node dies
- [ ] **Separate panel or stateless rebuild:** Know how to recover if the panel itself goes down with the node
