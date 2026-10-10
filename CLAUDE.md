# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

`agent-cli` is a **local, Copilot-CLI-style coding agent**. It runs a tool-using loop against a **local Qwen model served by LM Studio** (OpenAI-compatible API on `localhost:1234`). It reads and writes files in a *target project* (not in this repo), routes each task to a specialist agent, and asks the user to approve every file write and shell command.

- Default model: `qwen2.5-coder-32b-instruct-abliterated` (see `.env.local`).
- Everything must be able to run locally. Cloud backends (`.env.nim` for NVIDIA NIM) are optional and only reachable through the same OpenAI-compatible provider.
- TypeScript, CommonJS, Node 20+, run with `ts-node` (dev) or `tsc` (build).

## Commands

```bash
npm install
npm run typecheck        # tsc --noEmit  (run this after every change)
npm run build            # tsc -> dist/
npm run chat             # interactive session with .env.local (local Qwen)
npm run chat:nim         # same, with .env.nim (cloud endpoint, optional)
npx ts-node src/cli.ts run "task" -p /path/to/project [-a <agent>] [--no-mcp]
npx ts-node src/cli.ts agents
npm run models         # list models on the LM Studio server (+ native/fenced tool mode)
npm run bench          # first-token time and tok/s of the model in .env.local
npm run chat:qwen3     # profiles: chat:qwen3 | chat:devstral | chat:codestral (bench:* likewise)
```

LM Studio prerequisites: local server running, model loaded, and the model's **context length** set larger than prompt + `AI_MAX_TOKENS` (prompt and output share the window). If context is too small, replies are cut off no matter what the agent does.

## Architecture

```
src/
  cli.ts                 commander CLI: run / chat / agents. Starts MCP servers, wires Executor.
  server.ts              optional Fastify WebSocket server (--serve): forwards bus events to the web dashboard.
  core/
    executor.ts          THE agent loop: prompt build, tool dispatch, safety gates, history compaction.
    diff.ts              colored diff shown before a write is approved.
    events.ts            in-process event bus (bus.emit / bus.withRun). Core code only emits; it never imports the server.
    event-types.ts       wire types shared with web/ (types only, no runtime imports).
  llm/
    types.ts             LLMProvider / ChatMessage / ToolSchema / LLMResponse (finishReason, stats).
    models.ts            per-model profiles: native vs fenced tools, temperature, /no_think.
    factory.ts           createProvider(); wraps the provider in the cache.
    providers/lmstudio.ts  OpenAI-compatible provider: streaming, max_tokens, auto-continuation.
    cache.ts, cached-provider.ts   gzip response cache in .agent_cache/ (keyed by model + messages + tools).
  agents/
    definitions.ts       agent registry (AGENTS). Add new agents here.
    list/*.ts            dev, api, db, design, logic, kb-harvester, qa, debug (system prompt + injected knowledge).
    router.ts            keyword shortcut, then LLM fallback, then "dev".
    helpers.ts           loadKnowledge() and detectStackKnowledge().
  tools/
    fs.tool.ts           workspace-scoped file tools + tool schemas.
    search.tool.ts       find_files, grep.   shell.tool.ts  run_command (async, streams output, kills the whole process group on timeout).
    index.ts             non-interactive ToolDispatcher (scripts/tests). Executor does NOT use it.
    tree.ts              legacy, unused (superseded by FsTools.buildDirectoryTree).
  mcp/client.ts          dependency-free MCP stdio client + McpManager.
  knowledge/             markdown standards injected into agent prompts (see below).
mcp.config.json          MCP servers started at launch.
```

## The agent loop (core/executor.ts)

1. Detect the target project's stack, build the system prompt (agent prompt + knowledge + tool rules), and show the model a depth-2 project tree so it cannot guess the layout.
2. Call the LLM. Tool calls come either as native `tool_calls` or as fenced blocks in the reply.
3. Execute: consecutive **read-only** calls run together in one turn; `write_file`, `append_file`, `run_command` and non-auto-approved MCP calls run **one per turn** and need user confirmation.
4. Feed results back as `tool` messages. Old bulky messages are elided once history exceeds `AGENT_CONTEXT_CHARS`.

### Tool protocol

- Read tools: `read_file` (with `start_line`/`end_line`, truncated at ~40k chars), `read_multiple_files`, `list_directory`, `get_directory_tree` (`path` or legacy `rootDir`), `find_files`, `grep`.
- Write tools: `write_file`, `append_file`, `run_command`.
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

## Debug agent (`-a debug`)

For "X fails / crashes / does not start" tasks in any stack, e.g. `npx ts-node src/cli.ts run "npm run dev:api fails" -p /path/to/monorepo -a debug`. The router picks it when the task contains failure language (keywords in `router.ts`).

- Prompt: `agents/list/debug.ts`. Workflow: plan with `sequentialthinking` -> reproduce and collect symptoms (failing command, first error, git status/log/diff, versions vs declared versions, installed deps, ports, env names via `.env.example`) -> 2-4 ranked hypotheses, one tested at a time -> isolate -> smallest root-cause fix -> re-run the failing command -> report (Symptom / Root cause / Fix / Verified by / Follow-ups).
- Knowledge: `knowledge/08-logic/05-debugging-playbook.md` (triage order and per-ecosystem failure patterns: Node/TS, NestJS, Next.js, Python, .NET, JVM, monorepos), plus the root-cause file; cap 10000 chars.
- Agent flags in `AgentDefinition`: `thinkingBudget` (14 thinking calls instead of 8), `autoDiagnostics` (a strict regex allowlist of read-only commands such as `git status`, `node -v`, `lsof -i :PORT` runs without asking; everything else still asks; `AGENT_AUTO_DIAG=0` turns it off), `verifyFixes` (if files were changed and no command was run since, the executor sends one nudge to re-run the failing command; otherwise the answer must say UNVERIFIED).
- `run_command` takes `timeout_seconds` (5-180, default 30). It runs asynchronously, streams output, merges stdout/stderr in order, keeps the head and tail of long output, and on timeout stops the whole process group (so a dev server cannot linger and cause EADDRINUSE on the next try). `timedOut: true` on a server means it kept running, i.e. it started.

## Auto-write mode

By default every `write_file` / `append_file` shows a diff and asks for approval. Auto-write mode skips that and prints one log line per write (`✎ Creating new file <path> (N lines)`, `✎ Overwriting <path> (N lines)`, `✎ Appending N lines to <path>`). Useful for long unattended jobs such as harvesting knowledge from a project.

- `chat` asks at startup: "Let the agent write files and run commands automatically, without asking each time? (y/N)". `/auto-write` toggles it at any time; the prompt shows `[✎ auto-write]` while it is on.
- `run` takes `-y` / `--auto-write`. `AGENT_AUTO_WRITE=1` turns it on by default.
- Auto mode covers file writes AND `run_command`: each command prints `▶ Auto-running: <cmd>` and runs. `AGENT_AUTO_RUN=0` keeps command approval on even in auto mode.
- Risky commands still ask in auto mode (`DANGEROUS_COMMAND_RES` in `core/executor.ts`): sudo/su, rm/rmdir/unlink/shred/dd/chown/kill/pkill/killall/shutdown/reboot, `chmod -R`, git reset --hard / clean / push / rebase / checkout -- / restore / stash drop / branch -D / rm, `curl|wget ... | sh`, npm/pnpm/yarn publish or login or global install, docker rm/rmi/prune/volume rm, DROP/TRUNCATE, prisma migrate reset and similar, brew/pip/gem uninstall. The list is a best-effort filter, not a sandbox.
- Non-auto-approved MCP tools still ask. All safety gates (read-before-overwrite, directory inspection, placeholder refusal, shrink guard, secret-file block) stay active.
- Implementation: `ExecutorOptions.autoWrite`, `Executor.setAutoWrite()/isAutoWrite()`, branches in `handleWrite` and `handleAppend` (`core/executor.ts`).

## Preventing cut-off files

Three layers, all needed:

1. `lmstudio.ts` always sends `max_tokens` (`AI_MAX_TOKENS`, default 8192) and streams. When `finish_reason` is `length` it asks the model to continue and stitches the result (overlap-trimmed), up to `AI_MAX_CONTINUATIONS` times. Replies that still end in `length` are **never cached**.
2. The executor detects a block with no closing fence, writes nothing, and asks for smaller chunks.
3. Chunked `write_file` + `append_file`; after each successful write the tool result includes the last lines of the file so the next chunk continues exactly there. Written content is stripped from history afterwards to save context.

## MCP

`mcp/client.ts` is a small stdio JSON-RPC client (initialize, tools/list, tools/call). It is deliberately dependency-free: the official SDK's package `exports` do not resolve under this project's `moduleResolution: node`.

- `mcp.config.json` lists servers. Shipped: `sequential-thinking` (`@modelcontextprotocol/server-sequential-thinking` via `npx`, `autoApprove: true`), exposed to the model as the tool `sequentialthinking`, capped at 8 calls per task.
- Tool names are exposed bare when unique, `server__tool` on collision. Servers without `autoApprove` ask for confirmation.
- A server that fails to start prints a warning and the agent continues without it. `--no-mcp` disables all servers. `AGENT_MCP_CONFIG` overrides the config path.
- To add a server: add an entry to `mcp.config.json`; nothing else is required.
- `npx` downloads the server on first use. For fully offline use: `npm i -D @modelcontextprotocol/server-sequential-thinking` (npx then resolves the local copy).

## Knowledge system

The agent's file tools are scoped to the **target** project, so the agent can never open `src/knowledge` itself. Knowledge is therefore **injected into the system prompt**:

- `loadKnowledge([...paths])` (paths relative to `src/knowledge`) is called in each `agents/list/*.ts`, capped by `AGENT_SKILL_CHARS` (default 9000). A missing file prints a one-time warning; keep paths in sync with the folder names.
- `detectStackKnowledge(workspace)` inspects the target project (package.json deps, `*.csproj`, FastAPI, Xcode/Gradle markers, Appium references) and adds the matching standards (`05-backend`, `04-frontend`, `03-mobile`, `02-qa-automation`), capped at 6000 chars.
- Add a file: keep it short and imperative (~1.5 KB), then reference it in an agent's list or in `STACK_PRIORITY`/`inspectDir` in `helpers.ts`.
- `knowledge/uupm/` is a vendored UI/UX Pro Max skill pack (~35 KB of references, nested `src/knowledge/uupm/src/knowledge/uupm/...`). It is **not injected anywhere**; `10-design/design-standards.md` is the condensed version the design agent actually uses.

## Models & speed

See `docs/MODELS.md` for the model comparison, LM Studio settings and why numbers differ from reviews.

- **Profiles** (`llm/models.ts`): the model id picks native tool calling vs fenced blocks, temperature and `/no_think`. Codestral, Phi-4, DeepSeek-Coder and R1 have no tool template, so for them the provider sends no `tools` payload, the system prompt lists the tools (`Executor.toolReference`), and the history is flattened to alternating user/assistant text (`LMStudioProvider.toPlainMessages`), because strict templates reject the `tool` role. Override with `AI_NATIVE_TOOLS=on|off`.
- **Switching**: `--model <id>` on `run`/`chat`, `/model [id]` in chat (history kept), `npm run models` to list ids. The cache key includes model + tool protocol.
- **Measuring**: every LLM call prints `first token Xs · N tok/s` (`AI_STATS=0` hides it); `npm run bench` runs a fixed prompt without tools or cache. Use it to compare models instead of trusting claims.
- **Prefix stability**: LM Studio reuses work only for a byte-identical prompt prefix. Keep the system prompt and early history stable (no timestamps, no reordering); `compactHistory` is the one place that rewrites old messages.
- **Dense vs MoE**: dense models are slow at prompt processing; the dense env profiles lower `AGENT_CONTEXT_CHARS` and `AGENT_SKILL_CHARS`.

## Configuration (env)

`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL_NAME`, `AI_MAX_TOKENS`, `AI_TEMPERATURE` (default 0.2), `AI_MAX_CONTINUATIONS`, `AI_TIMEOUT_MS`, `AI_STREAM_PROGRESS`, `AI_CACHE=off`, `AI_NATIVE_TOOLS`, `AI_NO_THINK`, `AI_STATS`, `AI_PROVIDER`, `AGENT_MAX_STEPS`, `AGENT_AUTO_DIAG`, `AGENT_AUTO_RUN`, `AGENT_ROUTER`, `AGENT_CONTEXT_CHARS`, `AGENT_SKILL_CHARS`, `AGENT_MCP_CONFIG`, `AGENT_CACHE_DIR`, `AGENT_CMD_TIMEOUT_MIN`, `AI_VISION_MODEL`, and for the optional Gemini triage `GEMINI_API_KEY`, `AGENT_TRIAGE`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS`, `AGENT_TRIAGE_TIMEOUT_MS`, `AGENT_TRIAGE_MAX_CHARS`, `AGENT_TRIAGE_CONFIRM`. See `.env.example`. `.env.nim` holds a real cloud API key and is git-ignored; never print or commit it.

## Conventions

- Run `npm run typecheck` after every change; there is no test runner configured.
- When editing code here, produce **complete file replacements**, not diffs or fragments.
- Keep tool results and prompts compact: local models are slow and context-limited, so prefer capping/eliding over sending more text.
- New tools: add the schema next to its implementation, add a `case` in `Executor.dispatchToolCall`, and decide if it is read-only (add to `READ_ONLY_TOOLS`).
- New agents: create `agents/list/<id>.ts`, register it in `definitions.ts`, and add keywords to `router.ts` only if they are specific (generic words like "test" or "fix" must fall through to the LLM router).

## Long commands and Ctrl+C

- Builds, tests and installs (`gradlew`, `xcodebuild`, `mvn`, `npm run build|test|ci|install`, `docker build`, `fastlane`, `pod install` ...) get up to `AGENT_CMD_TIMEOUT_MIN` minutes (default 30; hard ceiling 2 h). The model's `timeout_seconds` is only honoured for servers/watchers and can never shorten a build command (`clampTimeoutMs(seconds, command)` in `tools/shell.tool.ts`). A command without a hint also gets the long limit.
- A heartbeat line (`still running, 2m 30s`) prints every 30 s so a quiet build does not look frozen.
- **Ctrl+C stops the running command**, not the CLI: the process group gets SIGINT, then SIGTERM after 2 s, SIGKILL after 5 s. The executor ends the task right away (`ExecutorResult.interrupted`); with nothing running, Ctrl+C exits as before. `core/interrupt.ts` resumes stdin in raw mode while a command runs, because the chat pauses readline during execution.

## Team mode (the "company") and reference pictures

Opt-in, all local. `/team <task>` runs one task with the team, `/team` toggles it for every task, `run "task" --team` does it from the shell.

- **Flow** (`src/team/orchestrator.ts`): Project Manager plans (one plain model call, JSON: goal, assumptions, risks, questions, <= 6 tasks with role + acceptance criteria) -> you approve the plan (skipped in auto-write mode and for dashboard runs) -> tasks run in order: `ux` writes a build spec (plain model call), the others run through the normal Executor with the existing agents (`design`, `dev`, `api`, `db`, `debug`, `qa`) -> **Safety Reviewer** (`safety`, `readOnly: true`) reads every written file and ends with `VERDICT: PASS|FAIL` -> on FAIL one fix round and one re-review -> PM delivery report built only from recorded facts (files written, commands run, verdict).
- Roles and all prompts live in `src/team/roles.ts`. `safety` is not in `AGENTS` (not routable, not lockable); PM and UX are plain model calls without tools.
- `AgentDefinition.readOnly` is enforced by the Executor: `write_file`/`append_file` are refused and only the read-only diagnostic allowlist may run.
- Each engineer gets a fresh small context (assignment + acceptance criteria + short notes on earlier steps), not one growing conversation: that keeps a local model fast. If the user presses Ctrl+C during a command the team stops after that task.
- If planning fails (bad JSON twice) or the plan is declined, the normal single-agent path runs.
- **Reference pictures** (`src/vision/describe.ts`): `/image <path> [note]` or `run --image <path>`. The coding model cannot see, so a vision model reads the picture once into a text design brief (layout, components, colours, typography, states, open questions) that is added to every following task (`/image show`, `/image clear`). Reader order: local LM Studio vision model `AI_VISION_MODEL`, else Gemini (needs `GEMINI_API_KEY` and a yes at the prompt, because the image goes to Google). The brief is an estimate of the picture, not a pixel measurement.

## Gemini triage gateway (optional, off by default)

`src/gateway/` puts a cloud "triage specialist" in front of the local agent. It is the ONLY feature that sends data off the machine, so it is opt-in: `run --triage`, `AGENT_TRIAGE=on`, the chat startup question, or `/triage` in chat (`/triage show` prints the plan last given to the agent).

- Flow: query -> `redact.ts` masks secrets -> `workspace-probe.ts` builds a file-name fingerprint (no file contents, no `.env`) -> `gemini.ts` asks Gemini for a JSON plan (validated by zod in `types.ts`) -> `render.ts` shrinks it to a compact text -> passed as `extraContext` to `Executor.run`; `recommendedAgent` replaces the local routing call unless an agent is locked.
- Failure never blocks: no key, no network, bad JSON -> a warning is printed and the local agent runs on the original query.
- The system instruction (stack knowledge for iOS, Android, NestJS, Next.js, Playwright, Appium) lives in `instruction.ts`.
- Models: `GEMINI_MODEL` then `GEMINI_FALLBACK_MODELS`; a "model not found" error moves to the next one. `npm run triage:models` lists what the key can use.
- Key goes in `.env` (git-ignored). Never in `.env.local` or the committed profile files.
- SDK `@google/genai` is ESM, so `gemini.ts` loads it with a native dynamic `import()` from this CommonJS project.

## Live web dashboard (monitor + control)

`web/` is a separate Vite + React + Tailwind app (own `package.json`, not part of the root `tsc`). It shows which agent holds the baton and a live feed of thinking, tool calls, streamed command output and written files. With a control token it can also send tasks and answer approvals.

```bash
npm install && npm run web:install   # once: root deps (fastify, @fastify/websocket) + web deps
npm run chat:ui                      # chat session + socket; starts the web app and opens the browser with the control token
npm run web                          # only if you disabled the auto-start (AGENT_UI_WEB=0): dashboard at http://localhost:5173
npx ts-node src/cli.ts run "task" -p /path --serve   # one-shot run, same socket
```

- Flow: `cli.ts` wraps routing + execution in `bus.withRun()`; `router.ts` and `executor.ts` call `bus.emit()`; `server.ts` subscribes and forwards. Events: run_started, orchestrator_evaluating, agent_routed, executor_ready, llm_request, agent_thinking, tool_running, tool_output, tool_result, approval_requested/resolved, artifact_generated, run_completed, run_failed.
- Adding an event: add its payload to `EventPayloads` in `core/event-types.ts`, emit it, then handle it in `web/src/state.ts` (the `switch` is exhaustive, so `web` typecheck tells you what is missing).
- Control path: `core/control.ts` (`control` singleton) is the UI-agnostic hook. `server.ts` calls `control.submitTask()` / `control.answerApproval()`; `cli.ts` (chat mode only) registers the task handler via `control.setTaskHandler()`; `Executor`'s `confirm()` asks `control.requestApproval()` when `bus.origin() === "dashboard"`. Runs started from the terminal keep the terminal `prompts` approval (the dashboard only displays it). One run at a time: `control.tryAcquire()/release()` guards both terminal and dashboard tasks.
- `src/ui-launcher.ts` (called from `setupUi` in `cli.ts`) starts `web/` (Vite) if port 5173 is free, waits for it, opens the tokenised URL, and stops Vite on exit. `AGENT_UI_WEB=0` / `AGENT_UI_OPEN=0` turn the two steps off. It needs `npm run web:install` once.
- Chat startup questions (existing project?, project path, auto-write, auto-run, Gemini triage) go through `control.ask()`: asked in the terminal (readline with an AbortSignal) and in the dashboard (`setup_question` / `setup_answered` events, `answer_question` command); the first answer wins and cancels the other prompt. The dashboard server starts BEFORE these questions. Open questions are replayed to late-joining dashboards via the event history.
- Workspace: answering "no" to "existing project?" uses `AGENT_DEFAULT_WORKSPACE` (set in `.env.local`; unset = the current folder). Answering "yes" asks for a path (Enter = the default, invalid folders re-ask up to 3 times, then the default is used).
- Auto-write and auto-run are separate: `Executor` has `autoWrite` and `autoRun` (`/auto-write` toggles both, `/auto-run` only commands, `AGENT_AUTO_RUN=0` forces commands to always ask).
- Baton display: `router.ts` emits `agent_routed` (methods keyword, llm, default, forced, triage); `Executor` also reports its agent in `executor_ready`, which the dashboard uses as a safety net. Any new code path that picks an agent must call one of the `announce*` helpers or go through `routeTask`.
- `run --serve` (one-shot) is watch-only: no task handler is registered.
- If the controlling browser disconnects while an approval is pending, it is rejected.
- The approval banner shows the message only; the file diff is printed in the terminal, and commands/args are visible in the feed.
- Security: the socket binds to 127.0.0.1, rejects browser origins other than localhost:5173 (`AGENT_UI_ORIGINS` adds more), and commands (submit_task, answer_approval) are only accepted from connections that present the random token (`?token=`, constant-time compared). Without the token a page is read-only. The agent can write files and run commands, so keep the token URL private. Env: `AGENT_UI_PORT` (3001), `AGENT_UI_TOKEN` (fixed token instead of random), `AGENT_UI_URL` (UI base URL printed with the token), `AGENT_UI_HISTORY` (400 replayed events), `VITE_AGENT_WS` (frontend socket URL).
- Wire protocol additions: client commands `ClientCommand` in `core/event-types.ts`; server messages `hello` (with `canControl`, `busy`), `event`, `busy`, `notice`.

## Gemini as lead and architect, Qwen as worker

- Roles: Gemini (free tier, `GEMINI_API_KEY` in `.env`) is the project lead and architect; the local Qwen is only the worker that reads, edits and runs commands. There is no paid cloud model (an Anthropic provider was removed; `factory.ts` throws for `anthropic`).
- Triage plan (`src/gateway`): besides the problem, hypotheses and steps it now carries `architecture` (approach, techChoices, filesToTouch, constraints) and `checks`. `render.ts` hands it to Qwen as "ARCHITECT'S PLAN (you are the worker)": execute, do not redesign, finish only when every check was run.
- Team mode: with Gemini triage ON (chat startup question, `/triage`, `--triage`, `AGENT_TRIAGE=on`) the Project Manager and the UX Designer run on Gemini through `TriageGateway.think()` -> `GeminiTriageClient.generateText()` (same model chain, retries and secret masking). `TeamOptions.think` is the hook; if Gemini fails the local model does the step. Engineers, the Safety Reviewer and the delivery report always run locally.
- Privacy: what Gemini sees is the request, a file-name overview of the project, and (team mode) the reference-design text and the planner/UX prompts. No file contents. Free-tier Gemini traffic may be used by Google to improve its products, so keep it off for confidential projects.

## Known gaps

- `src/tools/tools.test.ts` and `test-tools.ts` are entirely commented out; no test runner (vitest/jest) is installed.
- `README.md` is outdated (still describes DeepSeek R1 and an old layout).
- `tools/tree.ts` is dead code.
- The LLM response cache key includes the full message history, so it mainly helps identical re-runs.
- Shell commands run through `run_command` after user approval, or automatically in auto mode (except the risky-command list above); there is no sandbox. Auto mode runs model-chosen commands on your machine: use it on projects under version control.
