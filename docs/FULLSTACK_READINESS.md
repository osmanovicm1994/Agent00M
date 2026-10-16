# Full-stack readiness analysis

Date: 2026-10-16. Scope: can `agent-cli` take a prompt and deliver a production-grade full-stack app (Next.js + Tailwind, NestJS + custom JWT, PostgreSQL on Neon with Prisma/Drizzle, Cloudflare R2, Docker, VPS deploy, Playwright tests)?

Basis: the code and knowledge files as they are after the 2026-10 orchestration work (router, task standards, team mode, executor, shell/search/web/browser tools, `mcp.config.json`, `helpers.ts`, roles). Scores are my estimates from reading the code; nothing here was measured by running a full-stack benchmark. Package names and flags for third-party MCP servers are from memory and must be checked before they are added.

## 1. Executive verdict

| Scenario | Readiness (estimate) | Why |
| --- | --- | --- |
| Add features, fix bugs, write tests in an existing Next.js/NestJS repo | ~65% | Loop, safety gates, task standards, debug agent and tests are in place. Missing: stack-specific standards for Nest/Prisma/Neon, a verify-after-change gate for non-debug agents. |
| Scaffold and build the whole app from an empty folder, unattended | ~35% | Stack knowledge is not loaded for an empty workspace, scaffolders are interactive, plans are capped at 6 tasks and not persisted, no way to keep a dev server alive. |
| Prompt to production (Neon, R2, Docker, VPS deploy, CI) | ~20% | No knowledge or tools for any of it, and the right answer is a human-gated deploy anyway. |
| Polished, non-generic UI | ~40% | Good baseline standards, but no searchable design intelligence, no persisted design system, and no way to see the result. |

Short version: it is a solid single-repo coding agent with unusually good safety and honesty rules. It is not yet a project builder. The biggest blockers are not model intelligence but missing context (knowledge, stack detection, persisted plan) and missing process control (servers, verification gates).

One constraint sits above everything: the worker is a local 30B model with a 32k window. A whole app in one conversation will not work; the design must rely on small tasks, files as memory, and automatic verification.

## 2. What already works (verified in code)

- Tool loop with read-before-write, no placeholders, chunked `write_file` + `append_file`, diff approval, workspace-scoped file tools, `.env` blocked, long build timeouts, Ctrl+C.
- Routing to 9 agents, task-specific standards (logic first), reasoning core in every code agent, `route` dry-run command.
- Team mode: PM plan, UX spec, specialist engineers with fresh contexts, read-only Safety Reviewer with PASS/FAIL, delivery report from recorded facts.
- Debug agent: playbook, hypothesis loop, read-only auto diagnostics, verify-by-rerun nudge.
- Web: `web_search` (SearXNG), `web_fetch`, `web_research`. `inspect_page` for rendered-page facts. 82 unit tests.
- Safety: dangerous-command list, shell-write and out-of-project path prompts, git warning in auto mode.

## 3. Critical gaps matrix

Severity: **A** blocks the benchmark, **B** makes it unreliable, **C** polish.

### 3.1 Architecture and scaffolding

| # | Gap | Evidence | Sev |
| --- | --- | --- | --- |
| 1 | **Stack standards are not loaded for an empty workspace.** `detectStackKnowledge` looks for marker files (`package.json` with react/next, `.csproj`...). A new project has none, so the agent starts with no Next/Nest/Tailwind standards exactly when it makes the foundational decisions. | `helpers.ts` `inspectDir` | A |
| 2 | **No NestJS, Prisma, Drizzle, Neon, R2, Docker, auth, deploy knowledge.** `detectStackKnowledge` does not know them, and `KNOWLEDGE_RULES` has no rule for them. `07-api` and `06-database` are generic. | knowledge folders | A |
| 3 | **Scaffolders are interactive.** `create-next-app`, `nest new`, `prisma init` prompt for input. `run_command` closes stdin, so they fail or take defaults silently. No recipe tells the agent the non-interactive flags. | `shell.tool.ts` (`stdio: ["ignore", ...]`) | A |
| 4 | **Plan is capped and not persisted.** The PM prompt says "Never more than 6" tasks. A full-stack app is 20-40 steps. If a run dies, nothing records what was done. The only memory between tasks is short notes. | `team/roles.ts`, `team/orchestrator.ts` | A |
| 5 | **No multi-package awareness.** One workspace root, no concept of `apps/web` + `apps/api` + shared types, no rule for how the two share DTO types or an OpenAPI contract. | executor, roles | B |
| 6 | **The target project's own `AGENTS.md` / `CLAUDE.md` is not injected.** I found no code that loads it into the prompt (I read the executor only partly; please confirm). Project rules written by the user should be read first on every run. | executor `buildSystemPrompt` | B |
| 7 | **No per-task cap tuning for a large build.** `AGENT_MAX_STEPS` is 50 per task; a backend module with tests can exceed it. | `executor.ts` | C |

### 3.2 UI/UX and frontend intelligence

| # | Gap | Evidence | Sev |
| --- | --- | --- | --- |
| 8 | **`uupm` is vendored but unusable.** It sits in `src/knowledge/uupm` (note the nested `src/knowledge/uupm/src/knowledge/uupm` path), is not injected, and the agent cannot open it (file tools are scoped to the target project; `escapesWorkspace` also makes any command that names its path ask for approval). | `helpers.ts`, `command-safety.ts` | B |
| 9 | **No persisted design system.** Each run re-decides colors, type and spacing. Consistency across tasks and sessions depends on luck. | design agent | B |
| 10 | **Cannot judge the result.** `inspect_page` gives errors, overflow, a11y facts. It can save a screenshot but nothing reads it. The vision reader (`vision/describe.ts`) exists for reference pictures only. | `browser.tool.ts`, `vision/describe.ts` | B |
| 11 | **`inspect_page` needs a URL the user serves.** There is no way for the agent to start a dev server and keep it alive. | `shell.tool.ts` kills at timeout | A |

### 3.3 Tooling and MCP

| # | Gap | Sev |
| --- | --- | --- |
| 12 | **No managed background processes** (start dev server, wait for port, read its logs, stop it). This blocks `inspect_page`, Playwright against a running app, and API smoke tests. | A |
| 13 | **No up-to-date docs source.** `web_research` works but is slow and noisy for "what is the current Next.js 15/16 API". A docs-oriented MCP is the right tool. | B |
| 14 | No git workflow tools (commit per task, branch, diff summary). Possible through `run_command`, but there is no convention, so work is not checkpointed. | B |
| 15 | No database inspection (schema, run a read query, Neon branch). | B |
| 16 | No container or deploy tooling. Docker works through plain CLI; nothing generates or validates compose files, and nothing gates a production deploy. | B |
| 17 | MCP servers are limited to sequential-thinking (and a disabled `fetch`). The client works (stdio, tools only; no resources or prompts). | C |

### 3.4 Standards, guardrails, freshness

| # | Gap | Sev |
| --- | --- | --- |
| 18 | **Outdated-syntax risk is unmanaged.** The model's memory of Next.js, NestJS, Prisma, Tailwind v4 lags. No rule says "check the installed version, then the docs, before using an API", and no tool makes that cheap. | A |
| 19 | No OWASP checklist file, no secret scan, no `npm audit` step in the QA loop. The Safety Reviewer reads code but runs no scanners. | B |
| 20 | No "definition of done" for a full-stack change (typecheck + lint + unit + build + e2e smoke). | B |

### 3.5 Debugging and QA loop

| # | Gap | Sev |
| --- | --- | --- |
| 21 | **Self-correction loop is debug-only.** `verifyFixes` (nudge to re-run after edits) is set on the debug agent. The dev, api, db and design agents can finish after writing files without running anything. | A |
| 22 | Test output is handled as raw text (head and tail). No guidance to use JSON or list reporters, no trace reading, no structured failure summary. | B |
| 23 | Auto-diagnostics only allow a strict read-only list; fine, but there is no allowlist for the safe *verification* commands (`npm run typecheck`, `npm test`) so auto mode still asks about each unless auto-run is on. | C |
| 24 | The qa agent is Appium/Playwright-centric and is not told how to design a web E2E suite from scratch (fixtures, auth state, test data, `webServer`). | B |

## 4. The `uupm` question

**Recommendation: yes, integrate it, but as a native tool plus a persisted design file, not as prompt text and not as a Python shell-out.**

What is in it (from its folder listing): CSV catalogs (`styles`, `colors`, `typography`, `landing`, `products`, `charts`, `ux-guidelines`, `ui-reasoning`, `app-interface`, `react-performance`, icons, Google Fonts with licenses), per-stack guidance under `data/stacks`, and Python scripts (`search.py`, `design_system.py`). Also a CLI, a gallery, and skills for banners, brand, slides, which you do not need.

Why not the obvious options:
- Inject into the prompt: far too big for a 32k window. The condensed `design-standards.md` already is the injected version.
- Let the agent run `python3 .../search.py`: the script is outside the target project, so every call hits the out-of-project prompt; it needs Python; the agent does not know the path.
- Run its own MCP server: possible, but a TypeScript tool is simpler and testable.

Design:
1. **Tool `design_search`** (`src/tools/design.tool.ts`, read-only, added to `READ_ONLY_TOOLS`). Parameters: `domain` (style | color | typography | landing | product | ux | chart | stack), `query`, `stack` (optional), `limit` (default 5). It reads the CSVs from `src/knowledge/uupm/src/knowledge/uupm/src/ui-ux-pro-max/data` directly in Node (small CSV parser, keyword scoring), returns compact rows (a few hundred characters each), and never leaves the repo. Move that data folder to a stable path such as `src/design-data/` and keep the license file with it.
2. **Tool or step `design_system`** that composes one recommendation for a product type: pattern, style, palette (hex tokens), font pairing, spacing and radius scale, and anti-patterns. Port the logic of `design_system.py` or call the existing script once at build time to produce a JSON per product type.
3. **Persist the result in the target project** as `design-system/MASTER.md` plus a tokens file (`tokens.css` or the Tailwind theme). The design agent's prompt says: if `design-system/MASTER.md` exists, read it first and follow it; if not, create it with `design_search` before building UI. Every later task, and every later session, reuses the same decisions.
4. **Close the loop with a screenshot critique** (see section 5, item P2-3): `inspect_page` already can screenshot; feed it to the vision reader with a checklist taken from `MASTER.md`. This is the closest thing to "seeing" the UI.
5. Check the license of the pack before copying data into your repo, and keep attribution.

How it fits the architecture: new schema next to the implementation, a `case` in `dispatchToolCall`, an entry in `READ_ONLY_TOOLS`, a unit test with a tiny fixture CSV. About a day of work.

## 5. Recommended tool and MCP additions

Priority order. Verify each package name, flags and licence before adding; these are from memory.

| Pri | Addition | Type | Purpose |
| --- | --- | --- | --- |
| P1 | **Process manager tool** `proc_start / proc_wait_port / proc_logs / proc_stop` | custom tool (TypeScript, uses `spawn` detached, tracks pids, kills the group on exit) | Run dev servers and DBs in the background, wait for a port, read logs. Unblocks `inspect_page`, Playwright, API smoke tests. Must always stop processes when the run ends or on Ctrl+C. |
| P1 | **Verify gate** (not a tool): see 6.3 | executor change | Forces typecheck/test/build after writes. |
| P1 | **Context7 MCP** (`@upstash/context7-mcp`, tools to resolve a library id and fetch version-specific docs) | MCP, tools only (fits `mcp/client.ts`) | Current framework docs on demand: the answer to outdated syntax. |
| P2 | **`design_search` + `design_system`** | custom tool | Section 4. |
| P2 | **Playwright MCP** (`@playwright/mcp`) | MCP | Accessibility-tree snapshots, click/type, console and network. Gives the agent a way to exercise the running app without vision. Overlaps with `inspect_page`; keep `inspect_page` for one-shot facts, use the MCP for flows. Runs its own local Chromium, so it needs the same one-time browser install. |
| P2 | **Git helper commands** as knowledge, plus an optional `checkpoint` tool (`git add -A && git commit -m "<task>"` on a feature branch, refuses on main) | custom tool or recipe | Checkpoint after each verified task; makes runs resumable and reviewable. Push stays manual. |
| P3 | **GitHub MCP** (official `github-mcp-server`) | MCP | Issues, PRs, Actions logs. Use a fine-grained token; no push from the agent in auto mode. |
| P3 | **Neon MCP** (`@neondatabase/mcp-server-neon`) | MCP | Create a dev branch, run read queries, compare schema, run migrations on a branch. Point it at a dev branch only; never give the agent a production connection string. |
| P3 | **Postgres read-only inspection**: a `psql` recipe against the dev branch, or a small `db_query` tool that only accepts `SELECT`/`EXPLAIN` | custom tool | Schema and data inspection without a full MCP. |
| P3 | **Scanners as recipes**: `npm audit`, `gitleaks detect`, `trivy fs` | knowledge + safe-command allowlist | Real security checks in the QA loop. |
| P4 | **Docker**: plain CLI recipes (`docker compose config`, `build`, `up -d`, `logs`) plus allowlist for `config` and `ps` | knowledge | Validate compose files without a dedicated MCP. |
| P4 | **Deploy**: generate scripts and a runbook; a human runs them. If you want automation, a `deploy` tool that always asks, shows the exact `ssh` command, and is excluded from auto mode. | custom tool, gated | Safe VPS path. |

Suggested `mcp.config.json` additions (check names first):

```json
{
  "servers": {
    "sequential-thinking": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"], "autoApprove": true },
    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"], "autoApprove": true },
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest", "--headless"], "autoApprove": false }
  }
}
```

Keep `autoApprove` false for anything that writes (Neon, GitHub). Local models do worse with many tools: add servers per agent role if the tool list grows, rather than exposing everything to everyone.

## 6. System prompt and context enhancements

### 6.1 Knowledge packs to write (each 1.5-2 KB, imperative, "follow the project first")

| File | Content |
| --- | --- |
| `12-fullstack/00-build-protocol.md` | The protocol in 6.2 (new projects). |
| `12-fullstack/01-nextjs-app-router.md` | Current App Router rules: server components, server actions with validation and auth, route handlers, `loading/error`, caching and revalidation, env handling, `params` as promises, image/font. Tell the agent to confirm the installed major version and read current docs through Context7 for anything it is unsure of. |
| `12-fullstack/02-nestjs.md` | Module layout, DI, DTOs with class-validator + global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`), guards, interceptors, exception filter with Problem Details, config module with schema validation, Swagger, testing with `@nestjs/testing` and supertest. |
| `12-fullstack/03-auth-jwt.md` | Custom JWT done safely: argon2id, short access token, rotating refresh token stored hashed, httpOnly cookies, CSRF, guards, refresh reuse detection, rate limits on login, no secrets in the client. |
| `12-fullstack/04-prisma-drizzle.md` | Schema, migrations workflow (`prisma migrate dev` vs `deploy`), client singleton, transactions, seeds, and the Neon specifics below. Drizzle equivalent. |
| `12-fullstack/05-neon-postgres.md` | Pooled vs direct connection strings (pooled for the app, direct for migrations: Prisma `url` + `directUrl`), `sslmode=require`, branching for dev/test, serverless cold starts, connection limits, never commit connection strings. |
| `12-fullstack/06-cloudflare-r2.md` | S3-compatible API with `@aws-sdk/client-s3`, endpoint per account, presigned PUT/GET from the API, key naming, content-type and size limits, CORS on the bucket, public vs private buckets, never expose credentials to the browser. |
| `12-fullstack/07-docker-deploy.md` | Multi-stage Dockerfiles, non-root user, `.dockerignore`, compose with healthchecks, env files, migrations on deploy, reverse proxy (Caddy or nginx) with TLS, VPS hardening checklist, zero-downtime restart, rollback, backups. |
| `12-fullstack/08-ci-testing.md` | GitHub Actions (typecheck, lint, unit, build, Playwright with `webServer`), test data strategy, JSON reporter, what runs on every PR. |
| `10-design/design-system-protocol.md` | The `MASTER.md` workflow from section 4. |
| `07-api/05-owasp-checklist.md` | OWASP Top 10 mapped to concrete checks for Nest and Next (broken access control, injection, SSRF, misconfig, vulnerable components, logging failures). Also read by the Safety Reviewer. |

### 6.2 Build protocol block (inject for new-project tasks; also add to the PM prompt)

```
FULL-STACK BUILD PROTOCOL
1. Foundation first. Before writing feature code: decide and record the stack, folder layout, naming, env variable names,
   and the verification commands in docs/PROJECT.md (also create docs/PLAN.md, a checklist of small tasks).
2. Work in small vertical slices (one feature across db, api, web, test), each one finishing with the verification commands.
3. Never use an API from memory for a fast-moving framework. Check the installed version in package.json / the lockfile,
   then confirm the call in the docs tool (or web_research) when you are not certain. Say which version you assumed.
4. Scaffolders must run non-interactively (see the recipes). If a command asks a question, it failed: re-run with flags.
5. Secrets: only names in .env.example; real values are supplied by the user. Never print or commit them.
6. After every task: run typecheck, lint, the affected tests; fix until green; update docs/PLAN.md (tick the task, note decisions).
7. Never deploy, push, drop data or touch a production connection string. Produce scripts and a runbook; the user runs them.
8. Finish by listing: what was built, what was verified with which command, what was NOT verified.
```

Non-interactive recipes to include (check flags against the installed versions): `npx create-next-app@latest <dir> --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --yes` style flags; `npx @nestjs/cli new <dir> --package-manager npm --skip-git`; `npx prisma init --datasource-provider postgresql`; `npx playwright install --with-deps chromium`.

### 6.3 Code changes behind these blocks

1. **Stack rules from the task text** (`orchestration.ts`): add `KNOWLEDGE_RULES` for `next(\.?js)?`, `nest(js)?`, `prisma|drizzle`, `neon`, `r2|s3|object storage|presigned`, `docker|compose|vps|deploy|nginx|caddy`, `jwt|refresh token`, `github actions|ci`. Also let `detectStackKnowledge` accept a second input, the task, so an empty workspace still gets Next/Nest standards.
2. **Project context file**: in `buildSystemPrompt`, read `AGENTS.md` then `CLAUDE.md` from the workspace root (cap about 3000 characters, heading "PROJECT RULES (from the project, follow them)").
3. **Verify gate**: generalize `verifyFixes`. After any `write_file`/`append_file` in a run with no later `run_command`, send one nudge: run the project's check script (detected from `package.json`: `typecheck`, `lint`, `test`, `build`) and fix failures. Apply to `dev`, `api`, `db`, `design`, `qa`. Keep the debug agent's current wording.
4. **PM plan**: allow up to 12 tasks per milestone and add a `milestones` level; persist the plan and task status to `docs/PLAN.md` (or `.agent/plan.json`) after each task; on start, resume from it instead of re-planning.
5. **Safe verification allowlist**: allow `npm run typecheck|lint|test|build` and `npx tsc --noEmit` without asking when auto-run is on and the command contains no redirects (they are already auto-run; this is for the read-only roles).

## 7. Debugging and QA loop assessment

Strong: reproduce-first workflow, ranked hypotheses, a per-ecosystem playbook, first-error rule, timeouts that stop whole process groups, head/tail output condensing (the root error and the final stack are both kept), Ctrl+C that ends the task, honest "UNVERIFIED" rule.

Weak spots and fixes:
- The correction loop only exists for the debug agent (gap 21). Fix with the verify gate.
- Output is raw text. Add recipes for `--reporter=json` and `--reporter=list`, and a small `summarize_test_output` helper that extracts failing test names, first error and file:line from Jest, Vitest and Playwright output, so the model reads 30 lines instead of 3000.
- Playwright traces and screenshots on failure are not read. With `inspect_page` or the Playwright MCP the agent can reproduce a failing flow and read the console and network.
- No flaky-test protocol beyond the playbook. Add a `repeat-each` recipe (`npx playwright test --repeat-each=10 <file>`) to the qa knowledge.
- No retry budget: the loop stops at `AGENT_MAX_STEPS`. Add "same error three times: stop, summarize, ask" so it does not burn the window.

## 8. Phase-by-phase roadmap

**Status (2026-10-16): Phase 1 is implemented, not yet run.** Done: knowledge packs `12-fullstack/00-08` and `07-api/05-owasp-checklist.md`; task rules for Next.js, NestJS, JWT, Prisma/Drizzle, Neon, R2, Docker/deploy, CI and OWASP (so an empty workspace gets them from the task text); `AGENTS.md`/`CLAUDE.md` injection from the target project; Safety Reviewer reads the OWASP checklist; defaults raised to 5 files / 8000 characters; tests in `src/agents/fullstack.test.ts`. Not done from Phase 1: nothing; verify with `npm run typecheck && npm test` and `npx ts-node src/cli.ts route "<task>"`. 

**Phase 2 is implemented, not yet run (2026-10-16).** Done: verify gate for every code-writing agent plus a failed-last-command check (`executor.ts` 3b/3c); `start_process` / `process_logs` / `stop_process` (`tools/process.tool.ts`); `failureSummary` for long failing output and a stop-and-report note after the same failure 3 times (`core/run-feedback.ts`); whole-app tasks ("full-stack", "monorepo", "new app", "scaffold") route to `dev` with a `/team` hint instead of whichever specialist keyword matched. Tests: `run-feedback.test.ts`, `process.test.ts`, `fullstack-routing.test.ts`. Phase 2 tests passed on the owner's machine (2026-10-16).

**Phase 3 is implemented, not yet run (2026-10-16).** `update_plan` tool and `.agent/plan.md` (`core/plan.ts`): the plan is re-read at the start of the next run, survives context compaction (call `update_plan` with no arguments), and the executor nudges once if a run ends with open steps. Tests: `core/plan.test.ts`. Phase 3 tests passed on the owner's machine (2026-10-16). Not done: persisting the team-mode PM plan into the same file.

**Phase 4 is implemented, not yet run (2026-10-16).** `design_search` tool (`tools/design-search.tool.ts`, native BM25 over the uupm CSV catalogs, no Python), `design-system/MASTER.md` of the target project loaded into the `design` and `dev` prompts, workflow standard `10-design/design-system-workflow.md` with task rule `design-system`. Tests: `tools/design-search.test.ts` (uses small fixture CSVs; one test runs on the real catalog when present). Phase 4 tests passed on the owner's machine after two fixes (2026-10-16).

**Phase 5 is implemented, not yet run (2026-10-16).** MCP client: per-server tool allowlist (`tools`), per-tool auto-approve (`autoApproveTools`), `${VAR}` expansion in `args`/`env` (`mcp/client.ts`, tested in `mcp/client.test.ts`). `mcp.config.json` has `context7`, `playwright` (11 tools, localhost origins) and `github` as DISABLED entries; checked against the vendors' pages on 2026-10-16 (package names `@upstash/context7-mcp`, `@playwright/mcp`, image `ghcr.io/github/github-mcp-server`). Not verified: that each server starts and answers `tools/list` on this machine (needs Node/npx, Docker for github, a token) and that tool names match the allowlists. Neon MCP skipped: remote-only, vendor advises against production use. Phase 5 verified by the owner: all green and working (2026-10-16).

**Phase 6 is implemented, not yet run (2026-10-16).** `deploy_template` and `predeploy_check` (`tools/deploy.tool.ts`, tests in `tools/deploy.test.ts`), plus a "Deploy files" rule in `00-agent-core/tool-execution.md`. Not done: nothing builds an image or touches a server from here, so a real first deploy to the VPS (build, compose up, TLS, migrations, backup) is still a manual checklist. Phases 0 and 7 are untouched.

Each phase ends with a measurable check. Run `npm run typecheck && npm test` after each.

**Phase 0: baseline and benchmark (1 day).** Write the target app as a spec, split into about 20 slices, each with an acceptance command. Write a script that runs the agent per slice and records pass/fail, steps used and time. Run it now to get the real readiness number instead of my estimate. Exit: a table of pass rates per slice.

**Phase 1: knowledge and context (2-3 days).** Packs in 6.1, stack rules and empty-workspace detection, project `AGENTS.md` injection, non-interactive recipes, OWASP file. Update `registry.test.ts` expectations. Exit: `route` shows the right standards for 10 sample tasks; a "scaffold Next.js + Nest" run produces a compiling skeleton.

**Phase 2: verification loop and process control (3-4 days).** Verify gate, process manager tool, `inspect_page` against an agent-started server, Playwright `webServer` recipe, test-output summarizer, repeated-error stop. Exit: the agent builds one vertical slice (DB model, endpoint, page, e2e test) and ends with green commands it ran itself.

**Phase 3: planning that survives (3-4 days).** Persisted `PLAN.md`, milestones, resume, git checkpoint per task on a feature branch, PM limit raised, fresh contexts kept. Exit: kill a run midway; the next run resumes at the right task.

**Phase 4: design intelligence (2-3 days).** Move the `uupm` data, `design_search`/`design_system`, `MASTER.md` workflow, screenshot critique. Exit: two different product prompts produce visibly different, internally consistent design systems.

**Phase 5: live docs and integrations (2-3 days).** Context7 MCP, Playwright MCP, GitHub MCP, Neon MCP on a dev branch only. Exit: the agent corrects a deliberately outdated API call by checking the docs.

**Phase 6: deployment path (3-5 days).** Docker and compose generation validated with `docker compose config`, CI workflow, VPS runbook and scripts, a gated `deploy` helper if wanted. Exit: a fresh VPS (or a local VM) comes up from the generated files by following the runbook; the agent never touches production by itself.

**Phase 7: re-benchmark and tune (ongoing).** Re-run Phase 0. Tune `KNOWLEDGE_RULES` with `route`, trim standards that cost budget without helping, and decide whether the local model is enough or the Gemini stage should plan every milestone.

## 9. Risks to keep in view

- **Model ceiling.** If a 30B local model cannot keep NestJS + Prisma conventions straight, more standards will not help; measure in Phase 0 and consider a stronger model for planning and review only.
- **Prompt budget.** Every new standard competes for 9000 to 19000 characters. Keep packs short, load them by task, and measure what actually gets injected (`Task standards:` log line).
- **Autonomy and blast radius.** More tools (shell, DB, deploy) mean more ways to do damage. Keep production credentials out of reach, run on a branch, keep deploy and push manual.
- **MCP tool sprawl.** Small models pick tools worse as the list grows.
- **Licences.** Check `uupm` and any copied catalogs before shipping them.
