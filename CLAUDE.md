# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

`agent-cli` is a **local, Copilot-CLI-style coding agent**. It runs a tool-using loop against a **local model served by LM Studio** (OpenAI-compatible API on `localhost:1234`). It reads and writes files in a *target project* (not in this repo), routes each task to a specialist agent, and asks the user to approve every file write and shell command (unless auto mode is on).

- Model: set by `AI_MODEL_NAME`. `.env.example` ships `qwen2.5-coder-32b-instruct-abliterated`; the current `.env.local` uses `qwen/qwen3-coder-30b`. Other profiles: `.env.qwen3coder`, `.env.devstral`, `.env.codestral`.
- Everything must be able to run locally. Cloud backends (`.env.nim` for NVIDIA NIM) are optional and only reachable through the same OpenAI-compatible provider. The Gemini research stage is the only feature that sends data off the machine and is opt-in.
- TypeScript, CommonJS, Node 20+, run with `ts-node` (dev) or `tsc` (build). The dashboard in `web/` is a separate ESM project (Vite + React 19 + Tailwind 4).
- Further docs: `docs/AGENTS.md` (agent catalog, routing, team roles, how to add an agent), `docs/MODELS.md` (model comparison and LM Studio settings), `docs/REMOTE.md` (dashboard from outside the home network via Tailscale), `docs/FULLSTACK_READINESS.md` (gap analysis and roadmap for building a full-stack app from a prompt), `src/knowledge/README.md` (knowledge index).

## Commands

```bash
npm install
npm run typecheck        # tsc --noEmit  (run this after every change)
npm test                 # vitest run (unit tests, src/**/*.test.ts); npm run test:watch for watch mode
npm run build            # tsc -p tsconfig.build.json -> dist/ (tests excluded)
npx playwright install chromium   # once, only for the inspect_page tool
npm run chat             # interactive session with .env.local
npm run chat:nim         # same, with .env.nim (cloud endpoint, optional)
npm run chat:ui          # chat + live web dashboard (see "Live web dashboard"); chat:ui:lan also binds the LAN
npm run chat:ui:remote   # chat + dashboard reachable through Tailscale (works behind CGNAT); needs `npm run remote:on` once, see docs/REMOTE.md
npm run remote:on        # also remote:off | remote:status: Tailscale Serve for the dashboard (tailnet only, never Funnel)
npm run web:install      # once: install web/ dependencies;  npm run web = dashboard only (http://localhost:5173)
npx ts-node src/cli.ts run "task" -p /path/to/project [-a <agent>] [--no-mcp] [-y] [--research] [--team] [-i image.png] [--serve]
npx ts-node src/cli.ts agents
npx ts-node src/cli.ts route "task text" [-p /path/to/project]   # dry run: signals, chosen agent, task standards (no model call); use it to tune orchestration.ts
npm run models           # list models on the LM Studio server (+ native/fenced tool mode)
npm run bench            # first-token time, tok/s and tool-calling check of the model in .env.local
npm run bench:fullstack -- --baseline   # full-stack benchmark sanity check: every acceptance check must FAIL on an empty folder (no model needed)
npm run bench:fullstack -- --workspace ~/bench-app   # runs bench/fullstack/spec.json slice by slice through `run -y --no-mcp` (LM Studio, hours); results in bench/fullstack/results/; --accept-only, --from, --only, --max, --stop-on-fail, --team, --compare a.json b.json
npm run chat:qwen3       # profiles: chat:qwen3 | chat:devstral | chat:codestral (bench:* likewise)
npm run triage:models    # Gemini models the API key can use, and the order they are tried (--test pings each)
npm run search:test -- "query"   # run one web search through local SearXNG and show the plan, engines and any failures
npm run search:verify            # check SearXNG returns clean JSON for code, error, fact, news and weather queries (exit 1 on failure)
```

LM Studio prerequisites: local server running, model loaded, and the model's **context length** set larger than prompt + `AI_MAX_TOKENS` (prompt and output share the window). If context is too small, replies are cut off no matter what the agent does.

Chat slash commands (`/help` prints them): `/agents`, `/use <id>`, `/auto`, `/project`, `/model [id]`, `/auto-write`, `/auto-run`, `/research` (+ `show`; `/triage` is the old name), `/plan [auto|always|off]`, `/team [task]`, `/image <path> [note]` (+ `show`, `clear`), `/clear`, `/exit`. Ctrl+C stops a running command; a second Ctrl+C when idle exits.

## Architecture

```
src/
  cli.ts                 commander CLI: run / chat / agents / models / triage-models / search-test / bench. Starts MCP servers, wires Executor.
  server.ts              optional Fastify WebSocket server (--serve): forwards bus events to the web dashboard.
  ui-launcher.ts         starts/stops the Vite dashboard and opens the tokenised URL.
  core/
    executor.ts          THE agent loop: prompt build, tool dispatch, safety gates, history compaction.
    diff.ts              colored diff shown before a write is approved.
    events.ts            in-process event bus (bus.emit / bus.withRun). Core code only emits; it never imports the server.
    event-types.ts       wire types shared with web/ (types only, no runtime imports).
    plan.ts              persisted build plan: `.agent/plan.md` in the TARGET project (git-ignored via `.agent/.gitignore`). parse/render/applyPlanUpdate are pure; PlanStore reads/writes; planToolSchema = `update_plan`.
    run-feedback.ts      pure: errorSignature + RepeatTracker (same failure 3x -> stop note), summarizeFailures (failing lines of a long log), isCodeFile (what the verify gate checks).
    command-safety.ts    SAFE_DIAGNOSTIC_RES / isSafeDiagnostic and DANGEROUS_COMMAND_RES / isDangerousCommand (pure, unit-tested).
    control.ts           UI-agnostic control hook (tasks, approvals, startup questions) shared by terminal and dashboard.
    interrupt.ts         Ctrl+C handling while a command runs (raw-mode stdin).
  llm/
    types.ts             LLMProvider / ChatMessage / ToolSchema / LLMResponse (finishReason, stats).
    models.ts            per-model profiles: native vs fenced tools, temperature, /no_think.
    factory.ts           createProvider(); wraps the provider in the cache. `anthropic` throws (removed).
    providers/lmstudio.ts  OpenAI-compatible provider: streaming, max_tokens, auto-continuation.
    cache.ts, cached-provider.ts   gzip response cache in .agent_cache/ (keyed by model + messages + tools); pruned on start by age and size (AI_CACHE_TTL_DAYS, AI_CACHE_MAX_MB).
  agents/
    definitions.ts       agent registry (AGENTS) and the AgentDefinition type. Add new agents here.
    list/*.ts            dev, api, db, design (frontend developer), logic, kb-harvester, qa, debug, research.
    orchestration.ts     pure task analysis: DOMAIN_KEYWORDS + rankDomains (routing signals), KNOWLEDGE_RULES + selectTaskKnowledge (task-specific standards), analyzeTask (cross-cutting / team hint).
    router.ts            keyword shortcut (via orchestration), then one capped LLM call that also sees the signals, then "dev". Warns once if a signal group has no registered agent.
    helpers.ts           loadKnowledge(), detectStackKnowledge(), MOBILE_ROLE (which mobile files each role gets).
  research/              Gemini front stage: ResearchAgent + PlannerAgent + ResearchPipeline (see "Research stage"). Replaced the old triage flow.
  gateway/               Shared Gemini plumbing still used by research/ and the web tools: gemini.ts (client, resolveModels), redact.ts (secret masking), workspace-probe.ts (file-name fingerprint), render.ts, types.ts, instruction.ts. The old TriageGateway interceptor is gone; do not delete this folder.
  team/
    orchestrator.ts      team mode workflow.   roles.ts   PM / UX / report prompts, ROLE_TITLES, safetyAgent.
  vision/describe.ts     reference picture -> text design brief (local vision model, else Gemini).
  bench/
    fullstack-bench.ts   pure: spec schema, slice selection, summaries, markdown report, before/after compare.   run.ts  the runner (spawns the agent and the acceptance commands).
  tools/
    fs.tool.ts           workspace-scoped file tools + tool schemas.
    search.tool.ts       find_files, grep.   shell.tool.ts  run_command (async, streams output, kills the whole process group on timeout).
    web-search.tool.ts   web_search, web_fetch, web_research.
    deploy.tool.ts       deploy_template (Dockerfiles for Next/Nest, compose, Caddyfile, CI workflow, .dockerignore) and predeploy_check (read-only facts: non-root user, .dockerignore, literal secrets in deploy files, healthchecks, restart policy, published DB ports, Next standalone output, CI; it lists what it cannot verify). A test builds a project from the templates and requires zero FAIL/WARN, so templates and checks cannot drift apart.
    design-search.tool.ts  design_search: TypeScript port of the uupm BM25 search over its CSV catalogs (domains brief/style/color/typography/landing/product/ux/chart/web/react, or stack=nextjs|react|html-tailwind|shadcn|...). Data folder: `knowledge/uupm/src/knowledge/uupm/src/ui-ux-pro-max/data` or `UUPM_DATA_DIR`; a missing pack gives a plain "not available" message. Also `loadDesignSystem`: the target project's `design-system/MASTER.md` is added to the prompt of the `design` and `dev` agents (`AGENT_DESIGN_CHARS`, default 2500).
    process.tool.ts      start_process / process_logs / stop_process: background dev servers (detached, bounded log buffer, waits for a port or ready pattern, max 4, all stopped when the CLI exits).
    browser.tool.ts      inspect_page: headless Chromium (Playwright) facts about a localhost page or workspace .html file. Read-only.
    index.ts             non-interactive ToolDispatcher (scripts/tests). Executor does NOT use it.
    tools.test.ts        unit tests for the file/search tools and dispatcher.
  mcp/client.ts          dependency-free MCP stdio client + McpManager.
  knowledge/             markdown standards injected into agent prompts (see below).
web/                     separate Vite + React + Tailwind dashboard (own package.json, not part of the root tsc).
docs/                    AGENTS.md (agent catalog), MODELS.md (models and LM Studio settings).
mcp.config.json          MCP servers started at launch. Per server: `command`/`args`/`env` (`${NAME}` is filled from the environment, so tokens stay out of the file), `tools` (allowlist: every exposed tool schema costs context), `autoApprove`, `autoApproveTools`, `disabled`. Only `sequential-thinking` is enabled. Ready but disabled (set `"disabled": false` to use): `context7` (library docs; the query goes to Upstash's cloud, so it is opt-in), `playwright` (`@playwright/mcp`, headless, isolated, localhost origins only, 11 allowed tools: drives and checks the running app), `github` (Docker image, needs `GITHUB_PERSONAL_ACCESS_TOKEN` in `.env`; every call asks). Neon's MCP server is remote-only and not supported by the stdio client; use Prisma/Drizzle migrations instead.
_to_delete/              git-ignored, excluded from tsconfig: leftovers of the removed Anthropic provider, the old tools/tree.ts and test-tools.ts, and the superseded 08-logic/tool-execution.md. Safe to delete by hand.
```

Dependencies worth knowing: `zod` (all model JSON is validated), `prompts` (approvals), `picocolors`, `commander`, `fastify` + `@fastify/websocket`, `@google/genai` (ESM, loaded by dynamic `import()`), `cheerio` + `unpdf` (web_fetch), `duck-duck-scrape` / `google-sr` / `playwright` (scraped or browser-driven search engines, the least reliable ones; see Web access).

## The agent loop (core/executor.ts)

1. Detect the target project's stack, build the system prompt (agent prompt + knowledge + tool rules), and show the model a depth-2 project tree so it cannot guess the layout.
2. Call the LLM. Tool calls come either as native `tool_calls` or as fenced blocks in the reply.
3. Execute: consecutive **read-only** calls run together in one turn; `write_file`, `append_file`, `run_command` and non-auto-approved MCP calls run **one per turn** and need user confirmation.
4. Feed results back as `tool` messages. Old bulky messages are elided once history exceeds `AGENT_CONTEXT_CHARS`.

### Tool protocol

- Read tools: `read_file` (with `start_line`/`end_line`, truncated at ~40k chars), `read_multiple_files`, `list_directory`, `get_directory_tree` (`path` or legacy `rootDir`), `find_files`, `grep`, plus the web tools.
- Write tools: `write_file`, `append_file`, `run_command`, `start_process` (same approval and auto-mode rules as `run_command`; `process_logs` and `stop_process` need none).
- `deploy_template`, `predeploy_check` (read-only, batchable): see tools/deploy.tool.ts; the agent adapts a template and writes it with `write_file`.
- `design_search` (read-only, batchable): see tools/design-search.tool.ts. Workflow standard: `10-design/design-system-workflow.md` (task rule `design-system`, design and dev agents): a new UI starts with domain `brief`, saves `design-system/MASTER.md`, then builds tokens before components.
- `update_plan` (no approval, refused for read-only roles): `steps` replaces the list (finished steps with the same text stay done), `done`/`reopen` take 1-based step numbers, `goal`, `note`; no arguments = read the plan. The saved plan is appended to the first message of the next run, and a run that used `update_plan` gets one nudge (step 3d) if it ends with open steps. The team-mode PM plan is still not persisted.
- Verify gate (executor, step 3b/3c): a code-writing agent that changed a code file and ends without running any command since gets ONE nudge to run the narrowest check (or say UNVERIFIED); if its last command failed and nothing changed since, one nudge to fix it or report the failure honestly. `kb-harvester`, `research` and read-only roles are exempt. The same failure signature 3 times adds a stop-and-report note to the command result; failed runs with long output also get a `failureSummary`.
- Writes use a **raw fenced block**, never JSON-escaped content: the opening line carries the path.

  ````
  ```write_file src/foo.ts
  <raw content>
  ```
  ````

  Content that itself contains triple backticks (Markdown) uses a four-backtick fence. The parser is fence-aware (odd/even fence counting for 3-backtick blocks, longest-fence matching for 4+), so inner code fences do not end a block early.
- Long files (>~150 lines) are written as `write_file` (first chunk) + `append_file` (next chunks). `append_file` only continues a file written earlier in the same session and asks for confirmation each time.

### Safety gates (do not weaken without a reason)

- Workspace sandbox: `FsTools.resolve` uses `path.relative`, so `/proj-evil` cannot escape `/proj`.
- Never overwrite a file that was not read **completely** this session (truncated or ranged reads do not count).
- Never create a file in a directory that was not inspected (a new directory is checked via its nearest existing parent).
- Refuse comment placeholders such as `// ... rest of the file` (non-.md files) and warn once on big shrinks.
- New JS/TS files: warn once if imports are not declared in any `package.json`; warn once on same-name files elsewhere.
- Secret env files (`.env`, `.env.*` except `*.example`) cannot be read or grepped by the agent.
- The "claimed changes that were never made" guard and the nudge cap (`MAX_NUDGES`) protect against a model that narrates instead of acting.
- `AgentDefinition.readOnly` (Safety Reviewer): `write_file`/`append_file` are refused and only the read-only diagnostic allowlist may run.

## Agents

Full catalog, knowledge per agent, routing keywords and the "add an agent" checklist are in `docs/AGENTS.md`. Short version:

- Registered in `agents/definitions.ts`: `dev`, `api`, `db`, `design`, `logic`, `kb-harvester`, `qa`, `debug`, `research`. `agents/registry.test.ts` fails if an agent file is not registered, a routing group has no agent, or a prompt/rule points at a missing knowledge file.
- Routing order: forced agent (`-a`, `/use`, dashboard picker) > research-stage `recommendedAgent` > keyword score (one strict winner, `rankDomains` in `agents/orchestration.ts`) > one capped LLM call (sees the keyword signals) > `dev`. Keywords are deliberately specific. A research-style task that also has a change verb is not routed to `research`.
- **Task-specific standards**: besides the agent's own list and the detected stack standards, `selectTaskKnowledge(task, agentId)` adds up to `AGENT_TASK_FILES` (5) files within `AGENT_TASK_CHARS` (8000) from `KNOWLEDGE_RULES`, under "TASK-SPECIFIC STANDARDS" (logic standards weigh highest: edge cases, decomposition, root cause, distributed, debugging playbook; plus database/api/security/frontend/qa rules, and the full-stack packs in `12-fullstack/` matched on words like Next.js, NestJS, Prisma, Neon, R2, Docker, JWT, because a new project has no marker files for stack detection yet). `08-logic/00-reasoning-core.md` is part of every code-writing agent's own list. The PM and Safety Reviewer in team mode also get logic standards. When a change task spans 3+ build domains the executor prints a hint to use `/team`; it never switches modes itself.
- `safety` lives in `team/roles.ts`, is not in `AGENTS` (not routable, not lockable).
- Every agent file follows the same shape: `id`, `name`, `description` (short: the dashboard clamps it to two lines and the router lists it), `systemPrompt` built from a template string plus `loadKnowledge([...])`. Avoid backticks and `${` inside a prompt template string.

### Frontend developer agent (`-a design`)

`design` is the modern frontend developer: it builds real UI in the project's own stack (React/Next.js + TypeScript + Tailwind/CSS by default, other frameworks by their idioms), not mockups. Prompt in `agents/list/design.ts`; workflow: reconnaissance (tree, package.json, global styles/tokens, similar components) -> plan with `sequentialthinking` -> build in the project's conventions -> verify with the project's typecheck/lint/test/build scripts -> report (Built / Files / Verified by / Not verified / Notes). It cannot judge the rendered UI. It can call `inspect_page` (localhost URL or workspace .html; console errors, failed requests, overflow at 375/1280 px, structure and a11y problems) and must still list visual checks as "Not verified" instead of claiming visual correctness. It understands a UX SPEC (team mode), a DESIGN BRIEF (`/image`) and a TEAM ASSIGNMENT with acceptance criteria. Knowledge: `10-design/design-standards.md`, `04-frontend/modern-frontend.md`, `10-design/css-and-tailwind.md`; stack standards (`react-nextjs.md`, mobile `*-ui.md`) are added by `detectStackKnowledge`. The id stays `design` because the router, team roles, `MOBILE_ROLE` and dashboard use it.

## Debug agent (`-a debug`)

For "X fails / crashes / does not start" tasks in any stack, e.g. `npx ts-node src/cli.ts run "npm run dev:api fails" -p /path/to/monorepo -a debug`. The router picks it when the task contains failure language (the `debug` group in `DOMAIN_KEYWORDS`, `agents/orchestration.ts`).

- Prompt: `agents/list/debug.ts`. Workflow: plan with `sequentialthinking` -> reproduce and collect symptoms (failing command, first error, git status/log/diff, versions vs declared versions, installed deps, ports, env names via `.env.example`) -> 2-4 ranked hypotheses, one tested at a time -> isolate -> smallest root-cause fix -> re-run the failing command -> report (Symptom / Root cause / Fix / Verified by / Follow-ups).
- Knowledge: `knowledge/08-logic/05-debugging-playbook.md` (triage order and per-ecosystem failure patterns: Node/TS, NestJS, Next.js, Python, .NET, JVM, monorepos), plus the root-cause file; cap 10000 chars.
- Agent flags in `AgentDefinition`: `thinkingBudget` (14 thinking calls instead of 8), `autoDiagnostics` (a strict regex allowlist of read-only commands such as `git status`, `node -v`, `lsof -i :PORT` runs without asking; everything else still asks; `AGENT_AUTO_DIAG=0` turns it off), `verifyFixes` (if files were changed and no command was run since, the executor sends one nudge to re-run the failing command; otherwise the answer must say UNVERIFIED).
- `run_command` takes `timeout_seconds` (5-180, default 30). It runs asynchronously, streams output, merges stdout/stderr in order, keeps the head and tail of long output, and on timeout stops the whole process group (so a dev server cannot linger and cause EADDRINUSE on the next try). `timedOut: true` on a server means it kept running, i.e. it started.

## Auto-write mode

By default every `write_file` / `append_file` shows a diff and asks for approval. Auto-write mode skips that and prints one log line per write (`✎ Creating new file <path> (N lines)`, `✎ Overwriting <path> (N lines)`, `✎ Appending N lines to <path>`). Useful for long unattended jobs such as harvesting knowledge from a project.

- `chat` asks at startup (auto-write, then auto-run as separate questions). `/auto-write` toggles both at any time, `/auto-run` only commands; the prompt shows `[✎ auto-write]` and `[⚡ auto-run]` while on.
- `run` takes `-y` / `--auto-write`. `AGENT_AUTO_WRITE=1` turns it on by default.
- Auto mode covers file writes AND `run_command`: each command prints `▶ Auto-running: <cmd>` and runs. `AGENT_AUTO_RUN=0` keeps command approval on even in auto mode.
- Risky commands still ask in auto mode (`DANGEROUS_COMMAND_RES` in `core/command-safety.ts`): sudo/su, rm/rmdir/unlink/shred/dd/chown/kill/pkill/killall/shutdown/reboot, `find -delete`, tee/truncate/mv, `sed -i`/`perl -i`, shell output redirects (`>`, `>>`, except /dev/null and 2>&1; the agent should use write_file), any command that names a path outside the project (`escapesWorkspace`: absolute paths elsewhere, `~`, `$HOME`, `..`), `chmod -R`, git reset --hard / clean / push / rebase / checkout -- / restore / stash drop / branch -D / rm, `curl|wget ... | sh`, npm/pnpm/yarn publish or login or global install, docker rm/rmi/prune/volume rm, DROP/TRUNCATE, prisma migrate reset and similar, brew/pip/gem uninstall. The list is a best-effort filter, not a sandbox.
- Auto mode outside a git repository prints a one-time warning (`insideGitRepo()` in the executor).
- Non-auto-approved MCP tools still ask. All safety gates (read-before-overwrite, directory inspection, placeholder refusal, shrink guard, secret-file block) stay active.
- Implementation: `ExecutorOptions.autoWrite` / `autoRun`, `Executor.setAutoWrite()/isAutoWrite()`, `setAutoRun()/isAutoRun()`, branches in `handleWrite` and `handleAppend` (`core/executor.ts`).

## Preventing cut-off files

Three layers, all needed:

1. `lmstudio.ts` always sends `max_tokens` (`AI_MAX_TOKENS`, default 8192; `.env.example` and `.env.local` set 16384) and streams. When `finish_reason` is `length` it asks the model to continue and stitches the result (overlap-trimmed), up to `AI_MAX_CONTINUATIONS` times. Replies that still end in `length` are **never cached**.
2. The executor detects a block with no closing fence, writes nothing, and asks for smaller chunks.
3. Chunked `write_file` + `append_file`; after each successful write the tool result includes the last lines of the file so the next chunk continues exactly there. Written content is stripped from history afterwards to save context.

## MCP

`mcp/client.ts` is a small stdio JSON-RPC client (initialize, tools/list, tools/call). It is deliberately dependency-free: the official SDK's package `exports` do not resolve under this project's `moduleResolution: node`.

- `mcp.config.json` lists servers. Shipped: `sequential-thinking` (`@modelcontextprotocol/server-sequential-thinking` via `npx`, `autoApprove: true`), exposed to the model as the tool `sequentialthinking`, capped at 8 calls per task (per-agent `thinkingBudget` overrides). A `fetch` server (`uvx mcp-server-fetch`) is configured but `disabled: true`.
- Tool names are exposed bare when unique, `server__tool` on collision. Servers without `autoApprove` ask for confirmation.
- A server that fails to start prints a warning and the agent continues without it. `--no-mcp` disables all servers. `AGENT_MCP_CONFIG` overrides the config path.
- To add a server: add an entry to `mcp.config.json`; nothing else is required.
- `npx` downloads the server on first use. For fully offline use: `npm i -D @modelcontextprotocol/server-sequential-thinking` (npx then resolves the local copy).

## Knowledge system

The agent's file tools are scoped to the **target** project, so the agent can never open `src/knowledge` itself. Knowledge is therefore **injected into the system prompt**:

- `loadKnowledge([...paths])` (paths relative to `src/knowledge`) is called in each `agents/list/*.ts`, capped by `AGENT_SKILL_CHARS` (default 9000; `.env.local` sets 19000 for a 32k window). Files are added in list order and the **end is cut first**, so put the least important file last. A missing file prints a one-time warning; keep paths in sync with the folder names.
- The target project's own `AGENTS.md` and `CLAUDE.md` (workspace root) are added to the system prompt by `loadProjectContext` under "PROJECT RULES", capped by `AGENT_PROJECT_CHARS` (3500); they never override tool and safety rules.
- Task-specific files come from `selectTaskKnowledge` (see Agents) and are skipped when the agent already carries them. `08-logic/00-reasoning-core.md` (short) is second in every code agent's list so it survives small budgets.
- `detectStackKnowledge(workspace, agentId)` inspects the target project (package.json deps, `*.csproj`, FastAPI, Xcode/Gradle markers, Appium references) and adds the matching standards (`05-backend`, `04-frontend`, `03-mobile`, `02-qa-automation`), capped at 6000 chars. Mobile detail files are chosen per agent role (`MOBILE_ROLE` in `helpers.ts`).
- Folders: `00-agent-core`, `01-architecture`, `02-qa-automation`, `03-mobile`, `04-frontend` (`react-nextjs.md`, `modern-frontend.md`), `05-backend`, `06-database`, `07-api`, `08-logic`, `09-ai-agents`, `10-design` (`design-standards.md`, `css-and-tailwind.md`), `11-kb`, `12-fullstack` (build protocol, Next.js, NestJS, JWT auth, Prisma/Drizzle, Neon, R2, Docker/VPS, CI/testing; task-matched, see `docs/FULLSTACK_READINESS.md`). `src/knowledge/README.md` has the table of what is injected for whom.
- Writing standards: no path-comment headers or hard-wrapped bullets (they cost prompt budget), no LaTeX, no rule that contradicts "match the project" (say "follow the project first" when a standard names a specific library). Never mention folders the agent cannot open (for example `uupm`). Reviewed in full on 2026-10-15; the `ios-*` mobile files were read and left unchanged.
- Add a file: keep it short and imperative (~1.5-2 KB), then reference it in an agent's list or in `STACK_PRIORITY`/`inspectDir` in `helpers.ts`.
- `knowledge/uupm/` is a vendored UI/UX Pro Max skill pack. It is a **nested git clone with its own `.git`** and contains fonts, CSV catalogs, Python scripts and skills for Tailwind/shadcn, design tokens and slides. Its CSV catalogs are searched natively by the `design_search` tool (the Python scripts are not used). The folder itself is **not injected anywhere**; `10-design/design-standards.md` is the condensed version the frontend agent uses. Do not recurse into it when exploring the repo.

## Models & speed

See `docs/MODELS.md` for the model comparison, LM Studio settings and why numbers differ from reviews.

- **Profiles** (`llm/models.ts`): the model id picks native tool calling vs fenced blocks, temperature and `/no_think`. Codestral, Phi-4, DeepSeek-Coder and R1 have no tool template, so for them the provider sends no `tools` payload, the system prompt lists the tools (`Executor.toolReference`), and the history is flattened to alternating user/assistant text (`LMStudioProvider.toPlainMessages`), because strict templates reject the `tool` role. Override with `AI_NATIVE_TOOLS=on|off`.
- **Switching**: `--model <id>` on `run`/`chat`, `/model [id]` in chat (history kept), `npm run models` to list ids. The cache key includes model + tool protocol.
- **Measuring**: every LLM call prints `first token Xs · N tok/s` (`AI_STATS=0` hides it); `npm run bench` runs a fixed prompt without tools or cache and then probes native vs fenced tool calling. Use it to compare models instead of trusting claims.
- **Prefix stability**: LM Studio reuses work only for a byte-identical prompt prefix. Keep the system prompt and early history stable (no timestamps, no reordering); `compactHistory` is the one place that rewrites old messages.
- **Dense vs MoE**: dense models are slow at prompt processing; the dense env profiles lower `AGENT_CONTEXT_CHARS` and `AGENT_SKILL_CHARS`.

## Configuration (env)

Files: `.env.example` (documented reference, copy to `.env`), `.env.local` (default local profile, committed, no secrets), `.env.qwen3coder` / `.env.devstral` / `.env.codestral` (model profiles), `.env.nim` (real cloud key, git-ignored, never print or commit), `.env` (git-ignored; **keys go here**: `GEMINI_API_KEY`, `BRAVE_API_KEY`, `TAVILY_API_KEY`). Current `.env.local` values: `AI_MODEL_NAME=qwen/qwen3-coder-30b`, `AI_MAX_TOKENS=16384`, `AI_TEMPERATURE=0.3`, `AGENT_CONTEXT_CHARS=60000`, `AGENT_SKILL_CHARS=19000`, `SEARXNG_URL=http://localhost:8080`.

Variables: `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL_NAME`, `AI_MAX_TOKENS`, `AI_TEMPERATURE` (default 0.2), `AI_MAX_CONTINUATIONS`, `AI_TIMEOUT_MS`, `AI_STREAM_PROGRESS`, `AI_CACHE=off`, `AI_NATIVE_TOOLS`, `AI_NO_THINK`, `AI_STATS`, `AI_PROVIDER`, `AI_VISION_MODEL`, `AGENT_MAX_STEPS`, `AGENT_AUTO_WRITE`, `AGENT_AUTO_DIAG`, `AGENT_AUTO_RUN`, `AGENT_ROUTER`, `AGENT_CONTEXT_CHARS`, `AGENT_SKILL_CHARS`, `AGENT_STACK_CHARS`, `AGENT_TASK_FILES`, `AGENT_TASK_CHARS`, `AGENT_PROJECT_CHARS`, `AI_CACHE_TTL_DAYS`, `AI_CACHE_MAX_MB`, `AGENT_MCP_CONFIG`, `AGENT_CACHE_DIR`, `AGENT_CMD_TIMEOUT_MIN`, `AGENT_DEFAULT_WORKSPACE`; research stage: `GEMINI_API_KEY`, `AGENT_RESEARCH` (`AGENT_TRIAGE` = old name), `AGENT_PLANNER`, `AGENT_RESEARCH_GROUNDING`, `AGENT_RESEARCH_TIMEOUT_MS`, `AGENT_RESEARCH_MAX_CHARS`, `AGENT_RESEARCH_CONFIRM` (`AGENT_TRIAGE_CONFIRM`), `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS`, `AGENT_TRIAGE_TIMEOUT_MS`, `AGENT_TRIAGE_MAX_CHARS`, `AGENT_GROUNDING_BLOCK_MS`; web: `SEARXNG_URL`, `SEARXNG_ENGINES`, `SEARXNG_LANGUAGE`, `SEARXNG_TIMEOUT_MS` (15000), `WEB_SEARCH_ENGINES` (ignored), `BRAVE_API_KEY`, `TAVILY_API_KEY`, `WEB_TIMEOUT_MS`, `WEB_MAX_PAGE_BYTES`, `WEB_MAX_PDF_BYTES`, `WEB_PDF_MAX_PAGES`; dashboard: `AGENT_UI_PORT`, `AGENT_UI_TOKEN`, `AGENT_UI_URL`, `AGENT_UI_HISTORY`, `AGENT_UI_ORIGINS`, `AGENT_UI_WEB`, `AGENT_UI_OPEN`, `AGENT_UI_LAN`, `AGENT_UI_REMOTE`, `AGENT_UI_REMOTE_HOST`, `VITE_AGENT_WS`. See `.env.example` for what each does.

## Conventions

- Run `npm run typecheck && npm test` after every change. Tests are vitest, `src/**/*.test.ts` (`vitest.config.mts`); keep pure logic (routing, safety regexes, path resolution) in functions that can be tested without a model. (`web/` has its own `npm --prefix web run typecheck`.)
- When editing code here, produce **complete file replacements**, not diffs or fragments.
- Keep tool results and prompts compact: local models are slow and context-limited, so prefer capping/eliding over sending more text.
- New tools: add the schema next to its implementation, add a `case` in `Executor.dispatchToolCall`, and decide if it is read-only (add to `READ_ONLY_TOOLS`).
- New agents: create `agents/list/<id>.ts`, **register it in `definitions.ts`**, and add keywords to `DOMAIN_KEYWORDS` in `agents/orchestration.ts` only if they are specific (generic words like "test" or "fix" must fall through to the LLM router); add a `KNOWLEDGE_RULES` entry if its tasks need extra standards. Details: `docs/AGENTS.md`.
- Prompts are template strings: no backticks, no `${`. Put the least important knowledge file last in `loadKnowledge`.

## Long commands and Ctrl+C

- Builds, tests and installs (`gradlew`, `xcodebuild`, `mvn`, `npm run build|test|ci|install`, `docker build`, `fastlane`, `pod install` ...) get up to `AGENT_CMD_TIMEOUT_MIN` minutes (default 30; hard ceiling 2 h). The model's `timeout_seconds` is only honoured for servers/watchers and can never shorten a build command (`clampTimeoutMs(seconds, command)` in `tools/shell.tool.ts`). A command without a hint also gets the long limit.
- A heartbeat line (`still running, 2m 30s`) prints every 30 s so a quiet build does not look frozen.
- **Ctrl+C stops the running command**, not the CLI: the process group gets SIGINT, then SIGTERM after 2 s, SIGKILL after 5 s. The executor ends the task right away (`ExecutorResult.interrupted`); with nothing running, Ctrl+C exits as before. `core/interrupt.ts` resumes stdin in raw mode while a command runs, because the chat pauses readline during execution.

## Research stage and planner (Gemini, optional, off by default)

`src/research/` is the Gemini front stage. It replaced the older "triage gateway" (`/triage`, `--triage`, `AGENT_TRIAGE` still work as aliases). It is the ONLY feature that sends data off the machine, so it is opt-in: `run --research`, `AGENT_RESEARCH=on`, the chat startup question (asked only when a Gemini key exists), or `/research` in chat (`/research show` prints the last brief and plan).

```
user query -> ResearchAgent (Gemini) -- always first
                 brief: clarified problem, XY check, stacks, findings with sources, unknowns, needsPlan, recommendedAgent
                 |
          needsPlan? (or AGENT_PLANNER=always) -> PlannerAgent (Gemini, structured plan)
                 |
local agent (Executor.run) gets the brief (+ plan) as extra context; recommendedAgent replaces the local routing call
```

- `ResearchPipeline` (`research/index.ts`) holds the state: `plannerMode` (`/plan auto|always|off`), the last outcome, the previous turn (so "try again" follow-ups work). Brief and plan are shrunk by `render.ts` to `AGENT_RESEARCH_MAX_CHARS` (default 2800, 1800 when a plan exists).
- What Gemini sees: the request (secrets masked by `gateway/redact.ts`) and a file-name fingerprint of the project (`gateway/workspace-probe.ts`: stacks, package scripts, pinned runtimes, top-level folders; no file contents, no `.env`). Free-tier Gemini traffic may be used by Google to improve its products: keep it off for confidential projects.
- Google Search grounding inside the research stage is **off by default** (`AGENT_RESEARCH_GROUNDING=0`) because the free quota runs out fast (HTTP 429). On a quota error the stage keeps working without search and marks findings low-confidence; grounding pauses for `AGENT_GROUNDING_BLOCK_MS`. The local agent's own `web_search` is separate.
- Failure never blocks: no key, no network, quota, bad JSON -> a warning is printed and the local agent runs on the original query. All Gemini JSON is validated with zod (`research/types.ts`, with a prose fallback).
- `AGENT_RESEARCH_CONFIRM=1` asks before the brief/plan reaches the local agent (terminal only; dashboard runs skip the research stage in that case).
- Models: `GEMINI_MODEL` then `GEMINI_FALLBACK_MODELS`; a "model not found" error moves to the next one. `npm run triage:models` lists what the key can use. The key goes in `.env` (git-ignored), never in `.env.local` or the committed profile files.
- Gemini as lead, Qwen as worker: with the research stage ON, team mode's Project Manager and UX Designer run on Gemini through `ResearchPipeline.think()` (same model chain and secret masking). If Gemini fails the local model does the step. Engineers, the Safety Reviewer and the delivery report always run locally. There is no paid cloud model (the Anthropic provider was removed).

## Team mode (the "company") and reference pictures

Opt-in, all local unless the research stage is on. `/team <task>` runs one task with the team, `/team` toggles it for every task, `run "task" --team` does it from the shell.

- **Flow** (`src/team/orchestrator.ts`): Project Manager plans (one plain model call, JSON: goal, assumptions, risks, questions, <= 6 tasks with role + acceptance criteria) -> you approve the plan (skipped in auto-write mode and for dashboard runs) -> tasks run in order: `ux` writes a build spec (plain model call), the others run through the normal Executor with the existing agents (`design`, `dev`, `api`, `db`, `debug`, `qa`) -> **Safety Reviewer** (`safety`, `readOnly: true`) reads every written file and ends with `VERDICT: PASS|FAIL` -> on FAIL one fix round and one re-review -> PM delivery report built only from recorded facts (files written, commands run, verdict).
- Roles and all prompts live in `src/team/roles.ts`. `safety` is not in `AGENTS`; PM and UX are plain model calls without tools. A plan role that has no registered agent is skipped; unknown role ids fall back to `dev`.
- Each engineer gets a fresh small context (assignment + acceptance criteria + UX spec + short notes on earlier steps), not one growing conversation: that keeps a local model fast. If the user presses Ctrl+C during a command the team stops after that task.
- If planning fails (bad JSON twice) or the plan is declined, the normal single-agent path runs.
- **Reference pictures** (`src/vision/describe.ts`): `/image <path> [note]` or `run --image <path>`. The coding model cannot see, so a vision model reads the picture once into a text design brief (layout, components, colours, typography, states, open questions) that is added to every following task (`/image show`, `/image clear`). Reader order: local LM Studio vision model `AI_VISION_MODEL`, else Gemini (needs `GEMINI_API_KEY` and a yes at the prompt, because the image goes to Google). The brief is an estimate of the picture, not a pixel measurement.

## Live web dashboard (monitor + control)

`web/` is a separate Vite + React 19 + Tailwind 4 app (own `package.json`, not part of the root `tsc`). It shows which agent holds the baton and a live feed of thinking, tool calls, streamed command output and written files. With a control token it can also send tasks and answer approvals. Files: `Dashboard.tsx`, `components/` (`AgentRail`, `LiveFeed`, `RunHeader`, `SetupPanel`, `TaskComposer`), `state.ts` (event reducer), `protocol.ts`, `useAgentSocket.ts`. The agent cards come from the server roster (`name` + `description` of each registered agent), so changing an agent's name or description needs no web change.

```bash
npm install && npm run web:install   # once: root deps (fastify, @fastify/websocket) + web deps
npm run chat:ui                      # chat session + socket; starts the web app and opens the browser with the control token
npm run web                          # only if you disabled the auto-start (AGENT_UI_WEB=0): dashboard at http://localhost:5173
npx ts-node src/cli.ts run "task" -p /path --serve   # one-shot run, same socket
```

- Flow: `cli.ts` wraps routing + execution in `bus.withRun()`; `router.ts` and `executor.ts` call `bus.emit()`; `server.ts` subscribes and forwards. Events: run_started, orchestrator_evaluating, agent_routed, executor_ready, llm_request, agent_thinking, tool_running, tool_output, tool_result, approval_requested/resolved, artifact_generated, run_completed, run_failed (plus setup_question / setup_answered).
- Adding an event: add its payload to `EventPayloads` in `core/event-types.ts`, emit it, then handle it in `web/src/state.ts` (the `switch` is exhaustive, so `web` typecheck tells you what is missing).
- Control path: `core/control.ts` (`control` singleton) is the UI-agnostic hook. `server.ts` calls `control.submitTask()` / `control.answerApproval()`; `cli.ts` (chat mode only) registers the task handler via `control.setTaskHandler()`; `Executor`'s `confirm()` asks `control.requestApproval()` when `bus.origin() === "dashboard"`. Runs started from the terminal keep the terminal `prompts` approval (the dashboard only displays it). One run at a time: `control.tryAcquire()/release()` guards both terminal and dashboard tasks.
- `src/ui-launcher.ts` (called from `setupUi` in `cli.ts`) starts `web/` (Vite) if port 5173 is free, waits for it, opens the tokenised URL, and stops Vite on exit. `AGENT_UI_WEB=0` / `AGENT_UI_OPEN=0` turn the two steps off. It needs `npm run web:install` once.
- Chat startup questions (existing project?, project path, auto-write, auto-run, research stage) go through `control.ask()`: asked in the terminal (readline with an AbortSignal) and in the dashboard (`setup_question` / `setup_answered` events, `answer_question` command); the first answer wins and cancels the other prompt. The dashboard server starts BEFORE these questions. Open questions are replayed to late-joining dashboards via the event history.
- Workspace: answering "no" to "existing project?" uses `AGENT_DEFAULT_WORKSPACE` (set in `.env.local`; unset = the current folder). Answering "yes" asks for a path (Enter = the default, invalid folders re-ask up to 3 times, then the default is used).
- Baton display: `router.ts` emits `agent_routed` (methods keyword, llm, default, forced, triage); `Executor` also reports its agent in `executor_ready`, which the dashboard uses as a safety net. Any new code path that picks an agent must call one of the `announce*` helpers or go through `routeTask`.
- `run --serve` (one-shot) is watch-only: no task handler is registered.
- If the controlling browser disconnects while an approval is pending, it is rejected.
- The approval banner shows the message only; the file diff is printed in the terminal, and commands/args are visible in the feed.
- Security: the socket binds to 127.0.0.1 (`AGENT_UI_LAN=1` widens it), rejects browser origins other than localhost:5173 (`AGENT_UI_ORIGINS` adds more), and commands (submit_task, answer_approval) are only accepted from connections that present the random token (`?token=`, constant-time compared). Without the token a page is read-only. The agent can write files and run commands, so keep the token URL private. Env: `AGENT_UI_PORT` (3001), `AGENT_UI_TOKEN` (fixed token instead of random), `AGENT_UI_URL` (UI base URL printed with the token), `AGENT_UI_HISTORY` (400 replayed events), `VITE_AGENT_WS` (frontend socket URL).
- Wire protocol additions: client commands `ClientCommand` in `core/event-types.ts`; server messages `hello` (with `canControl`, `busy`), `event`, `busy`, `notice`.
- **Remote access (Tailscale)**: `AGENT_UI_REMOTE=1` (`npm run chat:ui:remote`). Full guide: `docs/REMOTE.md`. The socket and Vite keep binding to 127.0.0.1; Tailscale Serve (`scripts/remote.sh on`) proxies `https://<machine>.<tailnet>.ts.net` to Vite on 5173, and Vite proxies `/ws` to the agent port (`web/vite.config.ts`). `Dashboard.tsx` uses `wss://<same host>/ws` when the page is served over HTTPS. `src/remote.ts` finds the tailnet host name (`AGENT_UI_REMOTE_HOST` or `tailscale status --json`); `startServer` adds `https://<host>` to the origin allowlist, requires the token for every connection (like LAN mode), exports the host to the Vite child process, and prints the remote URL. Set a fixed `AGENT_UI_TOKEN` (24+ chars) in `.env`, never in a profile file. Do not use Tailscale Funnel.

## Web access (research agent and any agent that needs the web)

- `src/tools/web-search.tool.ts` exports three tools, all registered in `executor.ts` (`webToolSchemas`, read-only so they can be batched): `web_search` (technical docs AND real-time info such as news, weather, prices, scores, facts; ranked results from the local SearXNG only, requests paced 600 ms apart with a 15 s timeout; `web_research` searches sequentially, never in parallel), de-duplicated, max 2 per domain, trusted-docs boost, `site` and `recency` filters), `web_fetch` (one page to readable Markdown-ish text: main content only, code blocks and tables kept, page date; `query` returns only the relevant passages, `offset` pages through long ones; GitHub blob links become raw files; PDFs are read from their text layer with `unpdf`, scanned PDFs are not OCR'd) and `web_research` (up to 3 searches, reads the best 4-6 pages in parallel, returns passages with sources and dates).
- **Search is local only**: every query goes to your own SearXNG (`SEARXNG_URL`, default `http://localhost:8080`). No cloud search API (Gemini, Brave, Tavily) is used; `WEB_SEARCH_ENGINES` is ignored and the old brave/tavily/ddg/bing/google functions in the tool file are unreachable legacy code.
- **Search routing and verification**: `chooseSearch()` maps the query to SearXNG categories: code/docs/errors -> `general,it`; news words -> `news` with a day/week/month window; science/papers -> `general,science`; everything else (weather, facts) -> no categories parameter (the proven request shape; forcing `engines=` returned nothing on this instance). The `category` argument of `web_search`/`web_research` overrides it, an empty narrow category retries once as general, and `SEARXNG_ENGINES` can force an engine list. `npm run search:verify` checks the instance with code, error, fact, news and weather queries (clean JSON, >= 3 results with title and http(s) URL; exit code 1 on failure); `npm run search:test -- "query"` runs one search.
- Safety: queries pass through `gateway/redact.ts` before leaving the machine; `web_fetch` refuses localhost, private/link-local addresses and non-http(s) (checked after DNS and on every redirect); video is not read; page text is flagged as untrusted data. Results are cached 10 minutes in memory.
- `agents/list/research.ts` is the research agent (typed `AgentDefinition`, `thinkingBudget: 3`): web_research first, official sources first, verify with a second source, cite URLs and dates, mark unverified claims. The `research` keyword group in `orchestration.ts` routes to it.
- Pages that need JavaScript to render return no text (no headless browser is used for fetching). The separate `inspect_page` tool (`tools/browser.tool.ts`) does use headless Chromium, but only for localhost or workspace files, never for the open web.

## Known limits

- **Verified 2026-10-14:** `npm install`, `npm run typecheck` and `npm test` (6 files, 82 tests) pass on the owner's machine. Not yet exercised against a real model: live routing quality, task-standards injection in real runs, and `inspect_page` against a real page.
- The 3 `npm audit` findings (1 moderate, 2 critical) all came from vitest 3.x (`@vitest/mocker`, `tinypool`), a dev-only dependency never loaded by the CLI. `package.json` now pins `vitest ^5.0.4`; after `npm install`, `npm audit` should be clean. If vitest 5 breaks a test, fix the test rather than downgrading.
- The LLM response cache key includes the full message history, so it mainly helps identical re-runs (old entries are pruned by age and size).
- Shell commands run through `run_command` after user approval, or automatically in auto mode (except the risky-command list and commands that name paths outside the project, see above). There is still no real sandbox: a script the agent wrote can touch anything. Auto mode runs model-chosen commands on your machine: use it on projects under version control.
- `inspect_page` reports facts (errors, overflow, structure, a11y) but cannot judge how a page looks, and it needs a running dev server URL or a static .html file plus `npx playwright install chromium`. The frontend agent reports visual checks as "Not verified".
- Phase 2 (verify gate, process tool, repeated-error stop, whole-app tasks routed to `dev` with a `/team` hint) is implemented and unit-tested, but not yet exercised against a real model. Background processes are stopped on a normal exit; a hard kill of the CLI can leave a dev server running.
- Keyword routing and task rules are regex heuristics: tune `DOMAIN_KEYWORDS` / `KNOWLEDGE_RULES` and their tests when a task is misrouted.
- `gateway/` is still in use (shared Gemini plumbing for `research/`); only the old triage interceptor was removed.
