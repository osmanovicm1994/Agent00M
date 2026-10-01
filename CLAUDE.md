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
```

LM Studio prerequisites: local server running, model loaded, and the model's **context length** set larger than prompt + `AI_MAX_TOKENS` (prompt and output share the window). If context is too small, replies are cut off no matter what the agent does.

## Architecture

```
src/
  cli.ts                 commander CLI: run / chat / agents. Starts MCP servers, wires Executor.
  core/
    executor.ts          THE agent loop: prompt build, tool dispatch, safety gates, history compaction.
    diff.ts              colored diff shown before a write is approved.
  llm/
    types.ts             LLMProvider / ChatMessage / ToolSchema / LLMResponse (finishReason).
    factory.ts           createProvider(); wraps the provider in the cache.
    providers/lmstudio.ts  OpenAI-compatible provider: streaming, max_tokens, auto-continuation.
    cache.ts, cached-provider.ts   gzip response cache in .agent_cache/ (keyed by model + messages + tools).
  agents/
    definitions.ts       agent registry (AGENTS). Add new agents here.
    list/*.ts            dev, api, db, design, logic, kb-harvester, qa (system prompt + injected knowledge).
    router.ts            keyword shortcut, then LLM fallback, then "dev".
    helpers.ts           loadKnowledge() and detectStackKnowledge().
  tools/
    fs.tool.ts           workspace-scoped file tools + tool schemas.
    search.tool.ts       find_files, grep.   shell.tool.ts  run_command.
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

## Configuration (env)

`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL_NAME`, `AI_MAX_TOKENS`, `AI_TEMPERATURE` (default 0.2), `AI_MAX_CONTINUATIONS`, `AI_TIMEOUT_MS`, `AI_STREAM_PROGRESS`, `AI_CACHE=off`, `AI_PROVIDER`, `AGENT_MAX_STEPS`, `AGENT_CONTEXT_CHARS`, `AGENT_SKILL_CHARS`, `AGENT_MCP_CONFIG`, `AGENT_CACHE_DIR`. See `.env.example`. `.env.nim` holds a real cloud API key and is git-ignored; never print or commit it.

## Conventions

- Run `npm run typecheck` after every change; there is no test runner configured.
- When editing code here, produce **complete file replacements**, not diffs or fragments.
- Keep tool results and prompts compact: local models are slow and context-limited, so prefer capping/eliding over sending more text.
- New tools: add the schema next to its implementation, add a `case` in `Executor.dispatchToolCall`, and decide if it is read-only (add to `READ_ONLY_TOOLS`).
- New agents: create `agents/list/<id>.ts`, register it in `definitions.ts`, and add keywords to `router.ts` only if they are specific (generic words like "test" or "fix" must fall through to the LLM router).

## Known gaps

- `src/tools/tools.test.ts` and `test-tools.ts` are entirely commented out; no test runner (vitest/jest) is installed.
- `README.md` is outdated (still describes DeepSeek R1 and an old layout).
- `tools/tree.ts` is dead code.
- The LLM response cache key includes the full message history, so it mainly helps identical re-runs.
- Shell commands run through `run_command` after user approval only; there is no sandbox.
